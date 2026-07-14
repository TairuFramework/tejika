import { setTimeout as delay } from 'node:timers/promises'
import { TimeoutInterruption, withFileLock } from '@sozai/lock'
import { getPIDPath } from '@tejika/env'
import { createDeadline, type Deadline } from './deadline.js'
import { readDaemonState, removeDaemonState } from './state.js'
import { classifyState } from './status.js'

export type StopResult = {
  stopped: boolean
  pid?: number
  reason?: 'not-running' | 'not-owned' | 'timeout' | 'aborted' | 'busy' | 'error'
  /** Only with `reason: 'error'`: the failure `stopDaemon` refused to throw. */
  error?: unknown
}

export type StopDaemonOptions = {
  app: string
  pidPath?: string
  /** Boot/stop mutex path. Default `${pidPath}.lock`. */
  lockPath?: string
  /** Budget for taking the mutex. Default 10000ms. */
  lockTimeoutMs?: number
  /** Poll until the process exits, escalating to SIGKILL. Default true. */
  waitForExit?: boolean
  killTimeoutMs?: number
  signal?: AbortSignal
}

const EXIT_POLL_INTERVAL_MS = 50
const SIGKILL_GRACE_MS = 2_000
const DEFAULT_KILL_TIMEOUT_MS = 5_000
const DEFAULT_LOCK_TIMEOUT_MS = 10_000

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
  // `kill(-1, sig)` every process this user may signal. `isDaemonState` already
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
 * The critical section: classify, signal, wait, remove. Runs with the mutex HELD, which
 * is what lets every removal here be unconditional — no racer can write the state file
 * while we hold it, so the file we read is still the file we remove. That deletes the old
 * inode-guarded reap and its "or a rewrite of it that still names the pid we stopped"
 * fallback, both of which existed only to survive check-then-act.
 *
 * Never throws: `stopDaemon`'s contract is that it always resolves.
 */
async function stopLocked(pidPath: string, opts: StopDaemonOptions): Promise<StopResult> {
  const status = await classifyState(readDaemonState(pidPath))

  if (status.state === 'not-running') return { stopped: false, reason: 'not-running' }
  if (status.state === 'stale') {
    removeDaemonState(pidPath)
    return { stopped: false, pid: status.pid, reason: 'not-running' }
  }
  if (status.state === 'running-not-owned') {
    return { stopped: false, pid: status.pid, reason: 'not-owned' }
  }

  const pid = status.pid
  const killTimeoutMs = opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS
  try {
    const early = signalTolerantly(pid, 'SIGTERM')
    if (early != null) {
      if (early.stopped) removeDaemonState(pidPath)
      return early
    }

    if (opts.waitForExit === false) return { stopped: true, pid }

    if (await pollUntilGone(pid, createDeadline(killTimeoutMs, opts.signal))) {
      removeDaemonState(pidPath)
      return { stopped: true, pid }
    }

    const escalated = signalTolerantly(pid, 'SIGKILL')
    if (escalated != null && !escalated.stopped) return escalated
    if (await pollUntilGone(pid, createDeadline(SIGKILL_GRACE_MS, opts.signal))) {
      removeDaemonState(pidPath)
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
    return { stopped: false, pid, reason: 'error', error: err }
  }
}

/**
 * Stop the daemon named by the state file, under the boot mutex — so a `runDaemon` racing
 * this either precedes it or waits it out, and can never bind a socket while we are
 * killing its predecessor.
 *
 * Never throws: every outcome, including the caller's own `signal` aborting mid-stop,
 * resolves as a `StopResult`. A caller abort resolves with `reason: 'aborted'` rather
 * than `reason: 'timeout'` — the daemon's fate is genuinely unknown at that point, and
 * reporting a timeout would be a lie.
 *
 * A stop can hold the mutex for `killTimeoutMs` plus the SIGKILL grace. The daemon it is
 * killing must therefore NOT block on the mutex in its own shutdown path — see `cleanUp`
 * in `daemon.ts`.
 */
export async function stopDaemon(opts: StopDaemonOptions): Promise<StopResult> {
  const pidPath = opts.pidPath ?? getPIDPath(opts.app)
  const lockPath = opts.lockPath ?? `${pidPath}.lock`

  // Refuse up-front, exactly like `runDaemon`. The signal used to be consulted
  // only inside the exit poll — i.e. after the SIGTERM had already gone out — so
  // an already-aborted caller got `reason: 'aborted'` AND a killed daemon.
  // Aborted means "do not do this", not "do it and tell me you didn't".
  if (opts.signal?.aborted === true) return { stopped: false, reason: 'aborted' }

  try {
    return await withFileLock(lockPath, () => stopLocked(pidPath, opts), {
      timeout: opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      signal: opts.signal,
    })
  } catch (err) {
    // `stopLocked` never throws, so anything here came from the ACQUIRE.
    if (err instanceof TimeoutInterruption) {
      // Someone is booting or stopping this daemon and will not let go. Not a failure of
      // the stop, and not a timeout waiting for the daemon to die: a distinct outcome.
      return { stopped: false, reason: 'busy' }
    }
    if ((err as { name?: string }).name === 'AbortError') {
      return { stopped: false, reason: 'aborted' }
    }
    // An EACCES on the lock directory, say. Still not a rejection.
    return { stopped: false, reason: 'error', error: err }
  }
}
