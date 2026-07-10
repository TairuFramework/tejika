import { rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { connectSocket } from '@enkaku/socket'
import { createDeadline, type Deadline } from './deadline.js'

/**
 * `forbidden` means something IS listening but we may not connect (EACCES /
 * EPERM — typically another user's daemon). It must never be treated as dead:
 * a dead verdict authorises unlinking the socket file.
 */
export type SocketProbe = 'live' | 'dead' | 'forbidden'

const FORBIDDEN_CODES = new Set(['EACCES', 'EPERM'])

export async function probeSocket(socketPath: string): Promise<SocketProbe> {
  try {
    const socket = await connectSocket(socketPath)
    socket.destroy()
    return 'live'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? ''
    return FORBIDDEN_CODES.has(code) ? 'forbidden' : 'dead'
  }
}

/** True if something is actively listening on the socket (not just a stale file). */
export async function isSocketLive(socketPath: string): Promise<boolean> {
  return (await probeSocket(socketPath)) !== 'dead'
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
    if (deadline.expired()) throw new Error(`Timed out waiting for socket ${socketPath}`)
    try {
      await delay(Math.min(interval, deadline.remaining()), undefined, { signal: deadline.signal })
    } catch (err) {
      // The signal fired mid-sleep. The final sleep lands exactly on the deadline,
      // so the timer and any caller abort race in the same tick and delay() rejects
      // with an AbortError either way — remaining() is the arbiter, not the error.
      // Zero budget left is a timeout; anything else is the caller cancelling us.
      if (deadline.remaining() === 0) throw new Error(`Timed out waiting for socket ${socketPath}`)
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
