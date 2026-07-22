import { setTimeout as delay } from 'node:timers/promises'
import { TimeoutInterruption, withFileLock } from '@sozai/lock'
import { getPIDPath } from '@tejika/env'

import { createDeadline, type Deadline } from './deadline.js'
import { getLockPathFor, readDaemonState, removeDaemonState } from './state.js'
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
 * Poll until the process exits. Budget exhausted returns false (caller escalates). A caller
 * abort is not a timeout: it throws `AbortError`, which `stopDaemon` maps to
 * `reason: 'aborted'`. `timedOut()` arbitrates when abort and final timer share a tick.
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
 * Send a signal, treating ESRCH (already exited) as success. Returns a terminal result, or
 * null to continue. Never throws — an unexpected errno becomes `reason: 'error'`. `kill` is
 * injectable because no errno but ESRCH/EPERM can be provoked against a valid pid.
 */
export function signalTolerantly(
  pid: number,
  signal: 'SIGTERM' | 'SIGKILL',
  kill: (pid: number, signal: string) => void = (target, sig) => {
    process.kill(target, sig)
  },
): StopResult | null {
  // Defence in depth: `process.kill(0, sig)` signals the whole process group (the calling
  // CLI included), `kill(-1, sig)` every process this user may signal. `isDaemonState`
  // already refuses a non-positive pid; one reaching here is not a daemon — do not signal it.
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
 * Critical section: classify, signal, wait, remove — with the mutex HELD, which makes every
 * removal here unconditional (no racer can rewrite the file we read). Never throws:
 * `stopDaemon` always resolves.
 */
async function stopLocked(pidPath: string, opts: StopDaemonOptions): Promise<StopResult> {
  // Set `pid` as soon as a classification names one, before anything that could throw, so
  // the catch reports it on every failing path.
  let pid: number | undefined
  try {
    const status = await classifyState(readDaemonState(pidPath))

    if (status.state === 'not-running') return { stopped: false, reason: 'not-running' }
    pid = status.pid
    // FOOTGUN: `booting` is reaped like `stale`, its pid NEVER signalled. Proof: a
    // `ready: false` record is only written from inside this mutex, so one read while HOLDING
    // the mutex was written by a process that does not — abandoned by construction. Its pid is
    // not our daemon: either dead (already `stale`), or a RECYCLED pid naming an arbitrary live
    // process. The state file outlives a reboot (`~/.config/<app>`), so a daemon SIGKILLed
    // between claim and `ready: true` leaves exactly this record for a post-reboot `stop` —
    // signalling it would SIGKILL a stranger. Unlike a `ready: true` recycled pid (which
    // `classifyState` demotes to `stale` via the socket probe), `booting` has nothing to
    // probe, so the only safe act is to remove the record. `runDaemon` reclaims it the same way.
    if (status.state === 'stale' || status.state === 'booting') {
      removeDaemonState(pidPath)
      return { stopped: false, pid, reason: 'not-running' }
    }
    if (status.state === 'running-not-owned') {
      return { stopped: false, pid, reason: 'not-owned' }
    }

    const killTimeoutMs = opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS
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
    // A caller abort normally lands here (`pollUntilGone` resolves budget exhaustion via
    // `timedOut()`, not a throw). Honor never-throws: report it, and 'aborted' rather than
    // a guessed outcome — the daemon's fate is genuinely unknown.
    if ((err as { name?: string }).name === 'AbortError') {
      return { stopped: false, pid, reason: 'aborted' }
    }
    return { stopped: false, pid, reason: 'error', error: err }
  }
}

/**
 * Stop the daemon named by the state file, under the boot mutex — so a racing `runDaemon`
 * precedes or waits it out, never binding while we kill its predecessor. Never throws:
 * every outcome, including a mid-stop caller abort (`reason: 'aborted'`), is a `StopResult`.
 *
 * FOOTGUN: holds the mutex for up to `killTimeoutMs` + SIGKILL grace, so the daemon it kills
 * must NOT block on the mutex in its own shutdown — see `cleanUp` in `daemon.ts`.
 */
export async function stopDaemon(opts: StopDaemonOptions): Promise<StopResult> {
  const pidPath = opts.pidPath ?? getPIDPath(opts.app)
  const lockPath = opts.lockPath ?? getLockPathFor(pidPath)

  // Refuse up-front, like `runDaemon`: the signal used to be consulted only inside the exit
  // poll (after the SIGTERM), so an already-aborted caller got 'aborted' AND a killed daemon.
  if (opts.signal?.aborted === true) return { stopped: false, reason: 'aborted' }

  try {
    return await withFileLock(lockPath, () => stopLocked(pidPath, opts), {
      timeout: opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      signal: opts.signal,
    })
  } catch (err) {
    // Net for the ACQUIRE (common case — `stopLocked` resolves its own outcomes) and for
    // anything the critical section failed to handle.
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
