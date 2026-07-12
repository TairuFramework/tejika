import { rmSync } from 'node:fs'
import type { Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { type ConnectSocketOptions, connectSocket } from '@enkaku/socket'
import { createDeadline, type Deadline } from './deadline.js'

/**
 * The connect seam. `@enkaku/socket`'s own `connectSocket` is the default; the
 * indirection exists so the slow and abandoned paths — which a real AF_UNIX connect
 * essentially never takes — and errnos we cannot provoke for real (EMFILE) are
 * testable. An implementation MUST abandon the attempt when `options.signal` aborts,
 * and reject with `signal.reason`.
 */
export type ConnectSocket = (path: string, options?: ConnectSocketOptions) => Promise<Socket>

/**
 * Only `dead` is load-bearing, and only `dead` is dangerous: it is the verdict
 * that AUTHORISES unlinking the socket file (`controller`, `daemon`, and — via
 * `stale` — the boot path that reaps the lock). So it is stated positively and
 * every other outcome fails safe.
 *
 * - `live`: something answered.
 * - `forbidden`: something IS listening but we may not connect (EACCES / EPERM,
 *   typically another user's daemon).
 * - `unknown`: the connect failed for a reason that says nothing about the peer —
 *   EMFILE, ENOMEM, EAGAIN and friends are OUR failures, not the daemon's. A CLI
 *   under fd pressure must not conclude that a healthy daemon is dead and unlink
 *   its socket out from under it.
 */
export type SocketProbe = 'live' | 'dead' | 'forbidden' | 'unknown'

// ECONNREFUSED: the file is there, nothing is accepting. ENOENT: no file at all.
// ENOTSOCK: the path exists but is not a socket. These, and ONLY these, mean the
// peer is genuinely gone. Anything else is either a permission wall (something is
// there) or a local resource failure (we cannot tell) — never a licence to unlink.
const DEAD_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTSOCK'])
const FORBIDDEN_CODES = new Set(['EACCES', 'EPERM'])

/** Classify a failed connect. Exported for the tests that pin the safe default. */
export function classifyConnectError(err: unknown): SocketProbe {
  const code = (err as NodeJS.ErrnoException).code ?? ''
  if (DEAD_CODES.has(code)) return 'dead'
  return FORBIDDEN_CODES.has(code) ? 'forbidden' : 'unknown'
}

/**
 * `options` bounds the probe (`connectSocket` applies its own 10s default otherwise).
 * A caller with a budget passes its deadline's signal: an abandoned probe rejects with
 * an uncoded reason, which classifies as `unknown` — never `dead` — so cancelling a
 * probe can never authorise unlinking a live daemon's socket.
 */
export async function probeSocket(
  socketPath: string,
  connect: ConnectSocket = connectSocket,
  options?: ConnectSocketOptions,
): Promise<SocketProbe> {
  try {
    const socket = await connect(socketPath, options)
    socket.destroy()
    return 'live'
  } catch (err) {
    return classifyConnectError(err)
  }
}

/**
 * True if something is actively listening on the socket (not just a stale file).
 * Deliberately the complement of `dead`: `forbidden` and `unknown` both read as
 * live, because only `dead` may authorise removing the socket file.
 */
export async function isSocketLive(
  socketPath: string,
  connect?: ConnectSocket,
  options?: ConnectSocketOptions,
): Promise<boolean> {
  return (await probeSocket(socketPath, connect, options)) !== 'dead'
}

export type WaitForSocketOptions = { deadline?: Deadline; interval?: number }

/**
 * Poll until the socket accepts a connection. Two distinct failures:
 * budget exhausted rejects with the timeout `Error`; a caller abort propagates
 * the original `AbortError` untouched, so callers can tell "I cancelled this"
 * from "the daemon never came up".
 */
export async function waitForSocket(
  socketPath: string,
  options: WaitForSocketOptions = {},
): Promise<void> {
  const deadline = options.deadline ?? createDeadline(3000)
  const interval = options.interval ?? 50
  for (;;) {
    if (await isSocketLive(socketPath)) return
    // Only the clock running out is a timeout here. A caller abort that lands
    // during the probe falls through to the sleep below, where delay() rejects
    // immediately against the already-aborted signal and the catch rethrows it.
    if (deadline.timedOut()) throw new Error(`Timed out waiting for socket ${socketPath}`)
    try {
      await delay(Math.min(interval, deadline.remaining()), undefined, { signal: deadline.signal })
    } catch (err) {
      // The signal fired mid-sleep. The final sleep lands exactly on the deadline,
      // so the timer and any caller abort race in the same tick and delay() rejects
      // with an AbortError either way. timedOut() reads the timeout signal directly
      // — exact at the tick — so budget exhaustion becomes the timeout Error while a
      // caller cancellation keeps its own AbortError.
      if (deadline.timedOut()) throw new Error(`Timed out waiting for socket ${socketPath}`)
      throw err
    }
  }
}

/** Remove a socket file, tolerating concurrent removal (ENOENT). */
export function safeRemove(socketPath: string): void {
  try {
    rmSync(socketPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
