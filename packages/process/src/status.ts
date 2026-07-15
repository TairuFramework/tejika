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
    // Only ESRCH means gone. EPERM means alive but another user's — treating it as dead
    // would reap a live daemon's record and, in stopDaemon, signal an innocent process.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'not-owned' : 'dead'
  }
}

/**
 * Classify a presence record. Pure, lock-free, CLOCK-FREE: an unready record with a live
 * pid is `booting` however old it is. Whether it is abandoned is the boot mutex's call,
 * decided by proof (see `daemon.ts`), not a timeout.
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
    // Pid alive but socket dead: recycled pid, or the socket was unlinked. Either way no
    // client can reach it, so reclaiming the record is correct.
    return { state: 'stale', pid: state.pid }
  }
  return { state: 'running', pid: state.pid, socketPath: state.socketPath }
}

/** Classify the daemon's state file. Pure: never reaps, never blocks — reaping belongs to
 * the boot and stop paths, under the mutex. */
export async function getDaemonStatus(opts: {
  app: string
  pidPath?: string
}): Promise<DaemonStatus> {
  return await classifyState(readDaemonState(opts.pidPath ?? getPIDPath(opts.app)))
}
