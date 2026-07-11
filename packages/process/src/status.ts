import { setTimeout as delay } from 'node:timers/promises'
import { getPIDPath } from '@tejika/env'
import { createDeadline, type Deadline } from './deadline.js'
import { type LockRecord, readLockEntry, reapLockFile } from './lock.js'
import { probeSocket, type SocketProbe } from './socket.js'

export type DaemonStatus =
  | { state: 'not-running' }
  | { state: 'stale'; pid: number }
  | { state: 'booting'; pid: number; socketPath: string }
  | { state: 'running'; pid: number; socketPath: string }
  | { state: 'running-not-owned'; pid: number; socketPath: string }

/** Injected so `EPERM` and PID recycling are testable without a second user. */
export type StatusDeps = {
  kill: (pid: number, signal: 0) => void
  probe: (socketPath: string) => Promise<SocketProbe>
}

const DEFAULT_DEPS: StatusDeps = {
  kill: (pid, signal) => {
    process.kill(pid, signal)
  },
  probe: probeSocket,
}

export const DEFAULT_BOOT_GRACE_MS = 10_000

type Liveness = 'alive' | 'dead' | 'not-owned'

function checkLiveness(pid: number, kill: StatusDeps['kill']): Liveness {
  try {
    kill(pid, 0)
    return 'alive'
  } catch (err) {
    // Only ESRCH means the process is gone. EPERM means it exists and belongs to
    // another user — treating that as dead would reap a live daemon's lockfile
    // and, in stopDaemon, signal an innocent process.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'not-owned' : 'dead'
  }
}

export async function classifyRecord(
  record: LockRecord | null,
  options: { bootGraceMs: number; now: number },
  deps: StatusDeps = DEFAULT_DEPS,
): Promise<DaemonStatus> {
  // A corrupt record reads as null and is indistinguishable from no record.
  if (record == null) return { state: 'not-running' }

  const liveness = checkLiveness(record.pid, deps.kill)
  if (liveness === 'dead') return { state: 'stale', pid: record.pid }
  if (liveness === 'not-owned') {
    return { state: 'running-not-owned', pid: record.pid, socketPath: record.socketPath }
  }

  if (!record.ready) {
    // Claimed but not yet bound. Probing would race the bind, so trust the clock.
    return options.now - record.startedAt < options.bootGraceMs
      ? { state: 'booting', pid: record.pid, socketPath: record.socketPath }
      : { state: 'stale', pid: record.pid }
  }

  if ((await deps.probe(record.socketPath)) === 'dead') {
    // The pid is alive but its socket is not. Either the pid was recycled, or the
    // daemon's socket file was unlinked out from under it. Both leave the daemon
    // unreachable by every client, so reclaiming the lock is correct.
    return { state: 'stale', pid: record.pid }
  }
  return { state: 'running', pid: record.pid, socketPath: record.socketPath }
}

/**
 * Classify the lockfile AND capture the inode it was read from. Any reap that
 * follows must be guarded by that inode: classification is async, so by the time
 * a caller acts on the verdict the file at `pidPath` may already be a different
 * daemon's fresh lock.
 */
async function readStatus(
  pidPath: string,
  bootGraceMs: number,
): Promise<{ status: DaemonStatus; inode: number | null }> {
  const entry = readLockEntry(pidPath)
  const status = await classifyRecord(entry.record, { bootGraceMs, now: Date.now() })
  return { status, inode: entry.inode }
}

/**
 * Classify the daemon's lockfile. Pure: unlike the previous implementation this
 * never reaps a stale lockfile as a side effect. Reaping belongs to the boot
 * claim path, where it is inode-guarded.
 */
export async function getDaemonStatus(opts: {
  app: string
  pidPath?: string
  bootGraceMs?: number
}): Promise<DaemonStatus> {
  const pidPath = opts.pidPath ?? getPIDPath(opts.app)
  const { status } = await readStatus(pidPath, opts.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS)
  return status
}

export type StopResult = {
  stopped: boolean
  pid?: number
  reason?: 'not-running' | 'not-owned' | 'timeout'
}

export type StopDaemonOptions = {
  app: string
  pidPath?: string
  /** Poll until the process exits, escalating to SIGKILL. Default true. */
  waitForExit?: boolean
  killTimeoutMs?: number
  signal?: AbortSignal
}

const EXIT_POLL_INTERVAL_MS = 50
const SIGKILL_GRACE_MS = 2_000

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    // EPERM means it is still there, owned by someone else.
    return (err as NodeJS.ErrnoException).code !== 'EPERM'
  }
}

/**
 * Poll until the process exits. Budget exhausted returns false — the caller
 * escalates or reports a timeout. A CALLER abort is not a timeout: its
 * `AbortError` propagates untouched, out through `stopDaemon`, exactly as it does
 * in every other waiter here. `timedOut()` is the arbiter, so the two are told
 * apart even when the abort and the final timer land in the same tick.
 */
async function pollUntilGone(pid: number, deadline: Deadline): Promise<boolean> {
  for (;;) {
    if (isGone(pid)) return true
    if (deadline.timedOut()) return false
    try {
      await delay(Math.min(EXIT_POLL_INTERVAL_MS, deadline.remaining()), undefined, {
        signal: deadline.signal,
      })
    } catch (err) {
      if (deadline.timedOut()) return isGone(pid)
      throw err
    }
  }
}

/**
 * Send a signal, treating "already exited" as success. ESRCH between the status
 * read and the kill means the daemon exited on its own — a race we win, not an
 * error. Returns a terminal result, or null to continue.
 */
function signalTolerantly(pid: number, signal: 'SIGTERM' | 'SIGKILL'): StopResult | null {
  try {
    process.kill(pid, signal)
    return null
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return { stopped: true, pid }
    if (code === 'EPERM') return { stopped: false, pid, reason: 'not-owned' }
    throw err
  }
}

/**
 * Stop the daemon named by the lockfile. A caller abort rejects with the original
 * `AbortError` rather than resolving with a result — the daemon's fate is
 * genuinely unknown at that point, and reporting a timeout would be a lie.
 */
export async function stopDaemon(opts: StopDaemonOptions): Promise<StopResult> {
  const pidPath = opts.pidPath ?? getPIDPath(opts.app)
  // Capture the inode with the record we classify. EVERY reap below happens after
  // at least one await, so the file at `pidPath` may by then be a fresh lock a
  // racing `runDaemon` claimed after correctly reaping the stale one we just read.
  // Unlinking that would leave a live daemon with no lockfile: invisible to
  // `getDaemonStatus`, unstoppable, and blocking the socket for every later boot.
  const { status, inode } = await readStatus(pidPath, DEFAULT_BOOT_GRACE_MS)
  const reap = (): void => {
    if (inode != null) reapLockFile(pidPath, inode)
  }

  if (status.state === 'not-running') return { stopped: false, reason: 'not-running' }
  if (status.state === 'stale') {
    reap()
    return { stopped: false, pid: status.pid, reason: 'not-running' }
  }
  if (status.state === 'running-not-owned') {
    return { stopped: false, pid: status.pid, reason: 'not-owned' }
  }

  const pid = status.pid
  const early = signalTolerantly(pid, 'SIGTERM')
  if (early != null) {
    if (early.stopped) reap()
    return early
  }

  if (opts.waitForExit === false) return { stopped: true, pid }

  const killTimeoutMs = opts.killTimeoutMs ?? 5_000
  if (await pollUntilGone(pid, createDeadline(killTimeoutMs, opts.signal))) {
    reap()
    return { stopped: true, pid }
  }

  const escalated = signalTolerantly(pid, 'SIGKILL')
  if (escalated != null && !escalated.stopped) return escalated
  if (await pollUntilGone(pid, createDeadline(SIGKILL_GRACE_MS, opts.signal))) {
    reap()
    return { stopped: true, pid }
  }
  return { stopped: false, pid, reason: 'timeout' }
}
