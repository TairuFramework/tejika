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
  /** Bound on each connect attempt. Default 5000ms. */
  connectTimeoutMs?: number
}

/**
 * Full jitter: a uniform random value in `[0, ceiling)`. Without jitter, every
 * client of a restarted daemon reconnects in lockstep.
 */
export function nextBackoff(current: number, random: () => number = Math.random): number {
  const ceiling = current === 0 ? RECONNECT_BASE_MS : Math.min(current * 2, RECONNECT_MAX_MS)
  return random() * ceiling
}

/**
 * Connect, but never hang: Enkaku's `connectSocket` has no timeout of its own.
 * On timeout the still-pending connect is destroyed when it eventually settles,
 * so no socket leaks. (Upstream fix filed; this is the local mitigation.)
 */
async function connectWithTimeout(socketPath: string, timeoutMs: number): Promise<Socket> {
  const pending = connectSocket(socketPath)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void pending.then((socket) => socket.destroy()).catch(() => {})
      reject(new Error(`Timed out connecting to ${socketPath}`))
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
 */
export async function createDaemonTransport<Protocol extends ProtocolDefinition>(
  opts: CreateDaemonClientOptions,
): Promise<DaemonTransport<Protocol>> {
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const firstSocket = await connectWithTimeout(socketPath, connectTimeoutMs)

  let backoffMs = 0
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
      if (backoffMs > 0) await delay(backoffMs, undefined, { signal: shutdown.signal })
      const socket = await connectWithTimeout(socketPath, connectTimeoutMs)
      if (shutdown.signal.aborted) {
        socket.destroy()
        throw new Error('daemon client disposed')
      }
      currentSocket = socket
      // Reset only once the connection has PROVEN stable. Resetting on connect
      // lets an accept-then-crash daemon churn at the base delay forever.
      const stable = setTimeout(() => {
        backoffMs = 0
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
    backoffMs = nextBackoff(backoffMs)
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
    // `Disposer.dispose` is idempotent, so a `Client` disposing it too is a no-op.
    dispose: () => {
      shutdown.abort()
      const socket = currentSocket
      void currentTransport.dispose().then(
        () => socket.destroy(),
        () => socket.destroy(),
      )
    },
  }
}

/**
 * Connect an Enkaku `Client` to a running daemon, reconnecting automatically if
 * the daemon socket drops. A thin wrapper over `createDaemonTransport`.
 */
export async function createDaemonClient<Protocol extends ProtocolDefinition>(
  opts: CreateDaemonClientOptions,
): Promise<Client<Protocol>> {
  const { transport, handleTransportDisposed, handleTransportError, dispose } =
    await createDaemonTransport<Protocol>(opts)

  const client = new Client<Protocol>({ transport, handleTransportDisposed, handleTransportError })
  // Stop reconnecting before the client aborts its transport on dispose.
  client.events.on('disposing', () => dispose())
  return client
}
