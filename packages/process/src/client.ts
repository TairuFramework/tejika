import type { Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@enkaku/client'
import type {
  ClientMessage,
  ClientTransportOf,
  ProtocolDefinition,
  ServerMessage,
} from '@enkaku/protocol'
import { connectSocket, SocketTransport } from '@enkaku/socket'
import { getSocketPath } from '@tejika/env'

/** Reconnect backoff bounds: start fast, cap at a few seconds. */
const RECONNECT_BASE_MS = 250
const RECONNECT_MAX_MS = 5000
/** A connection must stay open this long before the backoff resets. */
const RECONNECT_STABLE_MS = 2000
const DEFAULT_CONNECT_TIMEOUT_MS = 5000

export type CreateDaemonClientOptions = {
  app: string
  socketPath?: string
  /** Aborting stops reconnection. */
  signal?: AbortSignal
  /**
   * Bound on each connect attempt of the PERMANENT reconnect loop. Default 5000ms.
   * This value outlives the call that created the client, so it must never carry a
   * per-call budget — see `initialConnectTimeoutMs`.
   */
  connectTimeoutMs?: number
  /**
   * Bound on the FIRST connect only. Defaults to `connectTimeoutMs`.
   *
   * Split from `connectTimeoutMs` because a caller with a total budget (see
   * `ensureDaemon`) must clamp its first connect to whatever is left of that
   * budget, yet the client it gets back is used long after the budget is spent. A
   * single shared value baked the clamp into the reconnect loop: a cold start that
   * consumed 9.99s of a 10s budget left the client reconnecting with an ~8ms
   * connect timeout forever, so every later reconnect to a perfectly healthy
   * daemon timed out, destroyed the socket that DID connect, and retried — a loop
   * with no exit.
   */
  initialConnectTimeoutMs?: number
}

export type Backoff = {
  /** The window the next delay is drawn from. Doubles per attempt, never shrinks. */
  ceilingMs: number
  /** The jittered sleep to actually perform: a uniform draw from `[0, ceilingMs)`. */
  delayMs: number
}

/**
 * Full jitter: sleep a uniform random value in `[0, ceiling)`. Without jitter,
 * every client of a restarted daemon reconnects in lockstep.
 *
 * The ceiling MUST be carried separately from the sleep. Deriving the next
 * ceiling from the previous jittered SLEEP (`ceiling = min(sleep * 2, MAX)`)
 * reads like doubling but is not: each step multiplies the ceiling by
 * `2 * random()`, whose expected log drifts by `ln2 - 1 ≈ -0.31`. The ceiling
 * collapses geometrically and the delays reach 0 and stay there — a client whose
 * daemon is down then reconnects at the timer floor forever, spinning the CPU and
 * churning fds. Only a draw of exactly 1.0 every time hides it, which is why a
 * test pinning `random = () => 1` saw nothing wrong.
 */
export function nextBackoff(ceilingMs: number, random: () => number = Math.random): Backoff {
  const next = ceilingMs === 0 ? RECONNECT_BASE_MS : Math.min(ceilingMs * 2, RECONNECT_MAX_MS)
  return { ceilingMs: next, delayMs: random() * next }
}

/**
 * Connect, but never hang: `@enkaku/socket`'s `connectSocket` offers no connect
 * timeout of its own and leaks its `connect`/`error` listeners. This is the
 * local mitigation: on timeout the still-pending connect is destroyed when it
 * eventually settles, so no socket leaks.
 *
 * `connect` is injectable so the timeout path — which a real AF_UNIX connect
 * essentially never takes — is testable.
 */
export async function connectWithTimeout(
  socketPath: string,
  timeoutMs: number,
  connect: (path: string) => Promise<Socket> = connectSocket,
): Promise<Socket> {
  const pending = connect(socketPath)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void pending.then((socket) => socket.destroy()).catch(() => {})
      // ETIMEDOUT, not a bare Error: `ensureDaemon` retries within its budget only
      // for errors it recognises as connect failures (by `code`). Uncoded, a
      // single slow connect attempt aborted the WHOLE ensureDaemon call instead of
      // being retried.
      const err = new Error(`Timed out connecting to ${socketPath}`) as NodeJS.ErrnoException
      err.code = 'ETIMEDOUT'
      reject(err)
    }, timeoutMs)
  })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

export type DaemonTransport<Protocol extends ProtocolDefinition> = {
  transport: ClientTransportOf<Protocol>
  handleTransportDisposed: () => ClientTransportOf<Protocol> | undefined
  handleTransportError: () => ClientTransportOf<Protocol> | undefined
  /** Abort reconnection; wire to the owning client's `disposing` event. */
  dispose: () => void
}

/**
 * The reconnect machinery, extracted from `createDaemonClient` so a consumer with
 * its own `Client` subtype can reuse it. Throws on the INITIAL connect if the
 * socket is absent or refused, so `ensureDaemon` can spawn the daemon; once
 * connected, later drops are healed transparently.
 *
 * `connect` is injectable for the same reason it is on `connectWithTimeout`: a
 * real AF_UNIX connect never takes the slow paths this must survive.
 */
export async function createDaemonTransport<Protocol extends ProtocolDefinition>(
  opts: CreateDaemonClientOptions,
  connect: (path: string) => Promise<Socket> = connectSocket,
): Promise<DaemonTransport<Protocol>> {
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  // The steady-state timeout. NOT the caller's first-connect clamp: this one is
  // reused by every reconnect for the whole life of the client.
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const initialConnectTimeoutMs = opts.initialConnectTimeoutMs ?? connectTimeoutMs
  const firstSocket = await connectWithTimeout(socketPath, initialConnectTimeoutMs, connect)

  // The ceiling is the state that must survive across attempts; the delay is a
  // fresh draw from it each time. Conflating the two is what made the backoff
  // decay to zero — see `nextBackoff`.
  let ceilingMs = 0
  let delayMs = 0
  // Aborted on dispose: cancels an in-flight backoff and stops the next reconnect,
  // so shutdown never opens a fresh socket after teardown.
  const shutdown = new AbortController()
  opts.signal?.addEventListener('abort', () => shutdown.abort(), { once: true })

  // A clean peer close yields a done-read in the client, which fires no reconnect
  // hook — so the transport is forced to dispose when its socket closes, routing
  // every drop through `handleTransportDisposed`.
  const firstTransport = new SocketTransport<ServerMessage, ClientMessage>({ socket: firstSocket })
  firstSocket.once('close', () => void firstTransport.dispose())

  // Track the live transport and its socket so `dispose()` can release both.
  // Enkaku's `Transport.dispose` only closes the writer if a stream was ever
  // lazily created, so a transport that was never read from or written to leaves
  // its socket open — disposing it alone is not enough to free the connection.
  let currentTransport: SocketTransport<ServerMessage, ClientMessage> = firstTransport
  let currentSocket: Socket = firstSocket

  const reconnectingTransport = (): SocketTransport<ServerMessage, ClientMessage> => {
    let self: SocketTransport<ServerMessage, ClientMessage>
    const source = async (): Promise<Socket> => {
      if (delayMs > 0) await delay(delayMs, undefined, { signal: shutdown.signal })
      const socket = await connectWithTimeout(socketPath, connectTimeoutMs, connect)
      if (shutdown.signal.aborted) {
        socket.destroy()
        throw new Error('daemon client disposed')
      }
      currentSocket = socket
      // Reset only once the connection has PROVEN stable. Resetting on connect
      // lets an accept-then-crash daemon churn at the base delay forever.
      const stable = setTimeout(() => {
        ceilingMs = 0
        delayMs = 0
      }, RECONNECT_STABLE_MS)
      stable.unref()
      socket.once('close', () => {
        clearTimeout(stable)
        void self.dispose()
      })
      return socket
    }
    self = new SocketTransport<ServerMessage, ClientMessage>({ socket: source })
    return self
  }

  // Both the disposed (clean close) and error (failed reconnect) paths reconnect.
  // During shutdown, return nothing so the client tears down instead.
  const nextTransport = (): ClientTransportOf<Protocol> | undefined => {
    if (shutdown.signal.aborted) return undefined
    ;({ ceilingMs, delayMs } = nextBackoff(ceilingMs))
    const transport = reconnectingTransport()
    currentTransport = transport
    return transport as unknown as ClientTransportOf<Protocol>
  }

  return {
    transport: firstTransport as unknown as ClientTransportOf<Protocol>,
    handleTransportDisposed: nextTransport,
    handleTransportError: nextTransport,
    // Releasing the transport and its socket here (not just aborting `shutdown`)
    // matters when the seam is used bare, without a `Client` on top: a `Client`
    // disposes the transport it holds, but a bare caller only ever sees
    // `dispose()`, and an undisposed socket keeps the peer's server alive.
    // Destroy AFTER the transport settles: its dispose closes the writer, which
    // ends the socket — ending an already-destroyed socket would raise
    // ERR_STREAM_DESTROYED on a socket whose error listener is already detached.
    // `Disposer.dispose` never rejects (internal errors are routed to
    // `onDisposeError`), so a single `.then` is enough; it is also idempotent,
    // so a `Client` disposing it too is a no-op.
    dispose: () => {
      shutdown.abort()
      const socket = currentSocket
      void currentTransport.dispose().then(() => socket.destroy())
    },
  }
}

/**
 * Connect an Enkaku `Client` to a running daemon, reconnecting automatically if
 * the daemon socket drops. A thin wrapper over `createDaemonTransport`.
 */
export async function createDaemonClient<Protocol extends ProtocolDefinition>(
  opts: CreateDaemonClientOptions,
  connect?: (path: string) => Promise<Socket>,
): Promise<Client<Protocol>> {
  const { transport, handleTransportDisposed, handleTransportError, dispose } =
    await createDaemonTransport<Protocol>(opts, connect)

  const client = new Client<Protocol>({ transport, handleTransportDisposed, handleTransportError })
  // Stop reconnecting before the client aborts its transport on dispose.
  client.events.on('disposing', () => dispose())
  return client
}
