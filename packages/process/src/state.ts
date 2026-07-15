import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * Daemon presence record — NOT the lock. Exclusion is the boot mutex's job (`@sozai/lock`
 * at `${pidPath}.lock`); this records who serves, where, and whether the socket is bound.
 * `ready` is false between claim and bind, so an observer tells booting from crashed.
 */
export type DaemonState = {
  pid: number
  socketPath: string
  startedAt: number
  ready: boolean
}

function isDaemonState(value: unknown): value is DaemonState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return (
    typeof state.pid === 'number' &&
    Number.isInteger(state.pid) &&
    // A non-positive pid is a weapon: `process.kill(0, sig)` signals the whole process
    // group (the reading CLI included), `kill(-1, sig)` every process the user may signal,
    // and both pass `kill(pid, 0)` — so the record would classify as a live daemon and be
    // signalled. Refuse it here, where every reader passes, like a corrupt record.
    state.pid > 0 &&
    typeof state.socketPath === 'string' &&
    typeof state.startedAt === 'number' &&
    typeof state.ready === 'boolean'
  )
}

/**
 * Read the record, or null if absent, unreadable, or non-conforming (treated as stale).
 * Lock-free by design — `getDaemonStatus` must never block behind a boot.
 */
export function readDaemonState(path: string): DaemonState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isDaemonState(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Write atomically (temp file + `rename`) so a lock-free reader sees the old record or the
 * new one, never a torn file. Fixed temp name is safe: only a mutex holder ever writes.
 */
export function writeDaemonState(path: string, state: DaemonState): void {
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, JSON.stringify(state), { encoding: 'utf8', flag: 'w', mode: 0o600 })
  try {
    renameSync(tmpPath, path)
  } catch (err) {
    rmSync(tmpPath, { force: true })
    throw err
  }
}

/**
 * Remove the record, unconditionally. Safe ONLY under the boot mutex, or behind the
 * pid+owner guard when the mutex could not be taken — see `daemon.ts`'s `cleanUp`.
 * Otherwise this unlinks whatever sits at the path, maybe a live daemon's fresh record.
 */
export function removeDaemonState(path: string): void {
  rmSync(path, { force: true })
}

/**
 * Boot/stop mutex path for a pidfile. Sole definition of the `.lock` suffix in this
 * package; must agree with `@tejika/env`'s `getLockPath(app)`. Used here rather than
 * `getLockPath` because callers work from an overridable `pidPath`, not an app name.
 */
export function getLockPathFor(pidPath: string): string {
  return `${pidPath}.lock`
}
