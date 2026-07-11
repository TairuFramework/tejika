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
const DEFAULT_CONNECT_TIMEOUT_MS = 1000

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
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTSOCK'])

function isConnectError(err: unknown): boolean {
  return CONNECT_CODES.has((err as NodeJS.ErrnoException).code ?? '')
}

async function connectWithRetry<Protocol extends ProtocolDefinition>(
  opts: EnsureDaemonOptions,
  socketPath: string,
  deadline: Deadline,
): Promise<Client<Protocol>> {
  const intervalMs = opts.intervalMs ?? 50
  for (;;) {
    try {
      return await createDaemonClient<Protocol>({
        app: opts.app,
        socketPath,
        connectTimeoutMs: opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        signal: deadline.signal,
      })
    } catch (err) {
      if (!isConnectError(err)) throw err
      // Only the clock running out is a timeout here. A caller abort that lands
      // here falls through to the sleep below, where delay() rejects immediately
      // against the already-aborted signal and the catch rethrows it untouched.
      if (deadline.timedOut()) throw new Error(`Timed out connecting to ${socketPath}`)
      try {
        await delay(Math.min(intervalMs, deadline.remaining()), undefined, {
          signal: deadline.signal,
        })
      } catch (sleepErr) {
        // The signal fired mid-sleep. `timedOut()` reads the timeout signal
        // directly — exact at the tick — so budget exhaustion becomes the
        // timeout Error while a caller cancellation keeps its own AbortError.
        if (deadline.timedOut()) throw new Error(`Timed out connecting to ${socketPath}`)
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
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS

  try {
    return await createDaemonClient<Protocol>({
      app: opts.app,
      socketPath,
      connectTimeoutMs,
      signal: deadline.signal,
    })
  } catch (err) {
    if (!isConnectError(err)) throw err

    // A refused connection on an existing socket file means a stale socket from a
    // crashed daemon. `forbidden` means another user's daemon is listening on it —
    // never unlink that.
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
