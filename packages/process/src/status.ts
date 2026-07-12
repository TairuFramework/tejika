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
  reason?: 'not-running' | 'not-owned' | 'timeout' | 'aborted' | 'error'
  /** Only with `reason: 'error'`: the failure `stopDaemon` refused to throw. */
  error?: unknown
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
 * escalates or reports a timeout. A CALLER abort is not a timeout: it throws the
 * original `AbortError`, which `stopDaemon` catches and turns into a
 * `reason: 'aborted'` result rather than reporting a timeout, preserving its
 * own never-throws invariant. `timedOut()` is the arbiter, so the two are told
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
 *
 * Never throws, because `stopDaemon` never throws: an unexpected errno becomes a
 * `reason: 'error'` result rather than a rejection. `kill` is injectable because
 * no real errno other than ESRCH/EPERM can be provoked against a valid pid.
 */
export function signalTolerantly(
  pid: number,
  signal: 'SIGTERM' | 'SIGKILL',
  kill: (pid: number, signal: string) => void = (target, sig) => {
    process.kill(target, sig)
  },
): StopResult | null {
  // Defence in depth at the authority that does the killing: `process.kill(0, sig)`
  // signals the ENTIRE process group — the CLI that called us included — and
  // `kill(-1, sig)` every process this user may signal. `isLockRecord` already
  // refuses a non-positive pid, so nothing should arrive here; if something does,
  // it is not a daemon and must not be signalled.
  if (!Number.isInteger(pid) || pid <= 0) return { stopped: false, pid, reason: 'not-running' }
  try {
    kill(pid, signal)
    return null
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return { stopped: true, pid }
    if (code === 'EPERM') return { stopped: false, pid, reason: 'not-owned' }
    return { stopped: false, pid, reason: 'error', error: err }
  }
}

/**
 * Stop the daemon named by the lockfile. Never throws: every outcome, including
 * the caller's own `signal` aborting mid-stop, resolves as a `StopResult`. A
 * caller abort resolves with `reason: 'aborted'` rather than `reason: 'timeout'`
 * — the daemon's fate is genuinely unknown at that point, and reporting a
 * timeout would be a lie.
 */
export async function stopDaemon(opts: StopDaemonOptions): Promise<StopResult> {
  const pidPath = opts.pidPath ?? getPIDPath(opts.app)

  // Refuse up-front, exactly like `runDaemon`. The signal used to be consulted
  // only inside the exit poll — i.e. after the SIGTERM had already gone out — so
  // an already-aborted caller got `reason: 'aborted'` AND a killed daemon.
  // Aborted means "do not do this", not "do it and tell me you didn't".
  if (opts.signal?.aborted === true) return { stopped: false, reason: 'aborted' }

  // Capture the inode with the record we classify. EVERY reap below happens after
  // at least one await, so the file at `pidPath` may by then be a fresh lock a
  // racing `runDaemon` claimed after correctly reaping the stale one we just read.
  // Unlinking that would leave a live daemon with no lockfile: invisible to
  // `getDaemonStatus`, unstoppable, and blocking the socket for every later boot.
  const { status, inode } = await readStatus(pidPath, DEFAULT_BOOT_GRACE_MS)

  // Re-read at reap time rather than trusting the captured inode alone: a daemon
  // stopped while still `booting` may have reached `markReady()` first, and that
  // is a RENAME — a new inode. The captured inode then matches nothing, the reap
  // silently no-ops, and `{ stopped: true }` is returned over a lockfile still
  // naming the pid we just killed. So unlink when the file is either the exact one
  // we classified, or a rewrite of it that still names the pid we stopped. A racing
  // daemon's fresh claim names a different pid and is never touched.
  const reap = (pid: number): void => {
    const entry = readLockEntry(pidPath)
    if (entry.inode == null) return
    if (entry.inode === inode || entry.record?.pid === pid) reapLockFile(pidPath, entry.inode)
  }

  if (status.state === 'not-running') return { stopped: false, reason: 'not-running' }
  if (status.state === 'stale') {
    reap(status.pid)
    return { stopped: false, pid: status.pid, reason: 'not-running' }
  }
  if (status.state === 'running-not-owned') {
    return { stopped: false, pid: status.pid, reason: 'not-owned' }
  }

  const pid = status.pid
  const killTimeoutMs = opts.killTimeoutMs ?? 5_000
  try {
    // Inside the try: `stopDaemon` NEVER throws, and this used to sit outside it.
    const early = signalTolerantly(pid, 'SIGTERM')
    if (early != null) {
      if (early.stopped) reap(pid)
      return early
    }

    if (opts.waitForExit === false) return { stopped: true, pid }

    if (await pollUntilGone(pid, createDeadline(killTimeoutMs, opts.signal))) {
      reap(pid)
      return { stopped: true, pid }
    }

    const escalated = signalTolerantly(pid, 'SIGKILL')
    if (escalated != null && !escalated.stopped) return escalated
    if (await pollUntilGone(pid, createDeadline(SIGKILL_GRACE_MS, opts.signal))) {
      reap(pid)
      return { stopped: true, pid }
    }
    return { stopped: false, pid, reason: 'timeout' }
  } catch (err) {
    // A CALLER abort is what normally reaches here: `pollUntilGone` resolves budget
    // exhaustion internally via `timedOut()` rather than throwing. Honor the
    // never-throws invariant by reporting it as a result instead of rejecting —
    // the daemon's fate is genuinely unknown, so 'aborted' rather than a guess.
    if ((err as { name?: string }).name === 'AbortError') {
      return { stopped: false, pid, reason: 'aborted' }
    }
    // Nothing else is expected to throw. If something does, it is still not a
    // rejection: this function's contract is that it always resolves.
    return { stopped: false, pid, reason: 'error', error: err }
  }
}
