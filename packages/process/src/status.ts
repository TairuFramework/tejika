import { getPIDPath } from '@tejika/env'
import { probeSocket, type SocketProbe } from './socket.js'
import { type DaemonState, readDaemonState } from './state.js'

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

type Liveness = 'alive' | 'dead' | 'not-owned'

function checkLiveness(pid: number, kill: StatusDeps['kill']): Liveness {
  try {
    kill(pid, 0)
    return 'alive'
  } catch (err) {
    // Only ESRCH means the process is gone. EPERM means it exists and belongs to
    // another user — treating that as dead would reap a live daemon's state file
    // and, in stopDaemon, signal an innocent process.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'not-owned' : 'dead'
  }
}

/**
 * Classify a daemon presence record. Pure, lock-free, and CLOCK-FREE: there is no boot
 * grace any more. An unready record with a live pid is `booting` however old it is —
 * deciding whether such a record is abandoned is the boot mutex's job, and the boot path
 * decides it by proof (a `ready: false` record read while holding the mutex was written by
 * a process that does not hold it) rather than by guessing at a timeout.
 */
export async function classifyState(
  state: DaemonState | null,
  deps: StatusDeps = DEFAULT_DEPS,
): Promise<DaemonStatus> {
  // A corrupt record reads as null and is indistinguishable from no record.
  if (state == null) return { state: 'not-running' }

  const liveness = checkLiveness(state.pid, deps.kill)
  if (liveness === 'dead') return { state: 'stale', pid: state.pid }
  if (liveness === 'not-owned') {
    return { state: 'running-not-owned', pid: state.pid, socketPath: state.socketPath }
  }

  if (!state.ready) {
    // Claimed but not yet bound. Probing would race the bind.
    return { state: 'booting', pid: state.pid, socketPath: state.socketPath }
  }

  if ((await deps.probe(state.socketPath)) === 'dead') {
    // The pid is alive but its socket is not. Either the pid was recycled, or the
    // daemon's socket file was unlinked out from under it. Both leave the daemon
    // unreachable by every client, so reclaiming the state file is correct.
    return { state: 'stale', pid: state.pid }
  }
  return { state: 'running', pid: state.pid, socketPath: state.socketPath }
}

/**
 * Classify the daemon's state file. Pure: never reaps, never blocks. Reaping belongs to
 * the boot and stop paths, which do it under the mutex.
 */
export async function getDaemonStatus(opts: {
  app: string
  pidPath?: string
}): Promise<DaemonStatus> {
  return await classifyState(readDaemonState(opts.pidPath ?? getPIDPath(opts.app)))
}
