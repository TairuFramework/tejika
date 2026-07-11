import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import type { Client } from '@enkaku/client'
import type { ProtocolDefinition } from '@enkaku/protocol'
import { getSocketPath } from '@tejika/env'
import { createDaemonClient } from './client.js'
import { createDeadline, type Deadline } from './deadline.js'
import { probeSocket, safeRemove } from './socket.js'
import { spawnDaemon } from './spawn.js'

const DEFAULT_TIMEOUT_MS = 10_000
// Named to avoid colliding with client.ts's own same-named-but-different-value
// DEFAULT_CONNECT_TIMEOUT_MS (5000ms, the createDaemonClient per-attempt default).
const CONNECT_ATTEMPT_TIMEOUT_MS = 1000

export type EnsureDaemonOptions = {
  app: string
  /** Daemon entry script spawned when no daemon is reachable. */
  entry: string
  args?: Array<string>
  socketPath?: string
  pidPath?: string
  logPath?: string
  /** Merged over `process.env` for the spawned daemon. */
  env?: Record<string, string>
  /** Total budget for the WHOLE call: connect, spawn, socket wait, retries. Default 10000ms. */
  timeoutMs?: number
  /** Delay between connect attempts. Default 50ms. */
  intervalMs?: number
  /** Bound on each individual connect attempt. Default 1000ms. */
  connectTimeoutMs?: number
  signal?: AbortSignal
}

// ENOTSOCK: the path exists but is not a socket (e.g. a leftover regular file
// from a crash, as opposed to ENOENT for no file at all). Both, like
// ECONNREFUSED, mean "nothing reachable here" and should route into the
// stale-socket recovery path below rather than propagate as a hard failure.
// ETIMEDOUT is `connectWithTimeout`'s own verdict: one attempt was too slow,
// which is a reason to retry inside the budget, not to abandon the whole call.
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTSOCK', 'ETIMEDOUT'])

function isConnectError(err: unknown): boolean {
  return CONNECT_CODES.has((err as NodeJS.ErrnoException).code ?? '')
}

// Exported for `connectWithRetry`'s own test coverage: a black-box test through
// `ensureDaemon` cannot reliably reach this loop's abort/timeout boundary. Any
// fixture socket that is "live" long enough for `spawnDaemon`'s own probe to see
// it is *also* live for this function's very next connect attempt — a raw
// `connect()` succeeds the instant the kernel queues it into the listening
// socket's backlog, independent of anything the server does afterward (even an
// immediate `destroy()` or self-`SIGKILL`), so `createDaemonClient` resolves
// before any server-side reaction can matter. Verified empirically: reactive
// (destroy-on-connection) and proactive (fixed-delay-then-close) fixtures alike
// either let the very first retry attempt slip through as a spurious success, or
// closed too early for `spawnDaemon`'s probe to ever observe "live" at all — no
// window reliably threads both needles. Testing this loop directly, against a
// deterministically non-listening socket, has none of that raciness.
export async function connectWithRetry<Protocol extends ProtocolDefinition>(
  opts: EnsureDaemonOptions,
  socketPath: string,
  deadline: Deadline,
): Promise<Client<Protocol>> {
  const intervalMs = opts.intervalMs ?? 50
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_ATTEMPT_TIMEOUT_MS
  for (;;) {
    try {
      return await createDaemonClient<Protocol>({
        app: opts.app,
        socketPath,
        // Never let one attempt outlive the shared budget it is spending.
        connectTimeoutMs: Math.min(connectTimeoutMs, deadline.remaining()),
        // The CALLER's own signal, not `deadline.signal`: this is the returned
        // client's permanent lifecycle signal (client.ts wires it straight to
        // `shutdown.abort()`, which permanently kills auto-reconnect). Passing
        // the deadline's signal here would mean `AbortSignal.timeout(timeoutMs)`
        // — which fires on wall-clock regardless of whether this call already
        // returned successfully — silently disables reconnect on every client
        // once the original call's budget elapses in the background.
        signal: opts.signal,
      })
    } catch (err) {
      if (!isConnectError(err)) throw err
      // Only the clock running out is a timeout here. A caller abort that lands
      // here falls through to the sleep below, where delay() rejects immediately
      // against the already-aborted signal and the catch rethrows it untouched.
      if (deadline.timedOut()) {
        throw new Error(`ensureDaemon timed out connecting to ${socketPath} (budget exhausted)`)
      }
      try {
        await delay(Math.min(intervalMs, deadline.remaining()), undefined, {
          signal: deadline.signal,
        })
      } catch (sleepErr) {
        // The signal fired mid-sleep. `timedOut()` reads the timeout signal
        // directly — exact at the tick — so budget exhaustion becomes the
        // timeout Error while a caller cancellation keeps its own AbortError.
        if (deadline.timedOut()) {
          throw new Error(`ensureDaemon timed out connecting to ${socketPath} (budget exhausted)`)
        }
        throw sleepErr
      }
    }
  }
}

/**
 * Ensure a daemon is running and return a connected client. `timeoutMs` bounds
 * the whole operation: the budget is threaded through the spawn's socket wait
 * and the connect retries rather than each imposing its own.
 */
export async function ensureDaemon<Protocol extends ProtocolDefinition>(
  opts: EnsureDaemonOptions,
): Promise<Client<Protocol>> {
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  const deadline = createDeadline(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal)
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_ATTEMPT_TIMEOUT_MS

  try {
    return await createDaemonClient<Protocol>({
      app: opts.app,
      socketPath,
      // Clamped to the budget: an unclamped 1000ms attempt against a 300ms
      // `timeoutMs` would blow through the deadline this call is supposed to obey.
      connectTimeoutMs: Math.min(connectTimeoutMs, deadline.remaining()),
      // The CALLER's own signal, not `deadline.signal` — see the matching
      // comment in `connectWithRetry`. This client may be handed back and used
      // for a long time; its reconnect lifecycle must not be tied to the
      // internal per-call timeout budget that bounds only THIS `ensureDaemon`
      // invocation.
      signal: opts.signal,
    })
  } catch (err) {
    if (!isConnectError(err)) throw err

    // A refused connection on an existing socket file means a stale socket from a
    // crashed daemon. `forbidden` means another user's daemon is listening on it —
    // never unlink that.
    // NOTE: this probe is not itself bounded by `deadline` (plain `connectSocket`,
    // no timeout/signal) — a crack in the "one budget bounds the whole call"
    // property. Low risk for a local AF_UNIX socket, left as-is rather than
    // restructuring `probeSocket`.
    if (existsSync(socketPath) && (await probeSocket(socketPath)) === 'dead') {
      safeRemove(socketPath)
    }

    await spawnDaemon({
      app: opts.app,
      entry: opts.entry,
      args: opts.args,
      socketPath,
      pidPath: opts.pidPath,
      logPath: opts.logPath,
      env: opts.env,
      deadline,
    })
    return await connectWithRetry<Protocol>(opts, socketPath, deadline)
  }
}
