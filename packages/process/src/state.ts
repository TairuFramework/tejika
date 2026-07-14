import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * The daemon's presence record — NOT a lock. Exclusion is the boot mutex's job
 * (`@sozai/lock`, at `${pidPath}.lock`); this file only says who is serving, where, and
 * whether it has finished binding. `ready` is false between claiming the state file and
 * binding the socket: an observer must be able to tell "booting" from "crashed after
 * claiming", and only the record can carry that distinction.
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
    // A non-positive pid is not a daemon, it is a weapon: `process.kill(0, sig)`
    // signals the WHOLE process group — the CLI reading this file included — and
    // `kill(-1, sig)` every process the user may signal. Worse, `kill(0, 0)`
    // succeeds, so such a record classifies as a LIVE daemon and walks straight
    // into `stopDaemon`'s SIGTERM. Refuse it here, where every reader passes:
    // a record that cannot be trusted is treated exactly like a corrupt one.
    state.pid > 0 &&
    typeof state.socketPath === 'string' &&
    typeof state.startedAt === 'number' &&
    typeof state.ready === 'boolean'
  )
}

/**
 * Read the record, or null when the file is absent, unreadable, or does not hold a
 * conforming record. Callers treat a corrupt record exactly as they treat a missing
 * one: stale. Lock-free by design — `getDaemonStatus` must never block behind a boot.
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
 * Write the record atomically: the content exists in full under a throwaway name before
 * `rename` gives it the name a reader looks up, so a lock-free reader sees the old record
 * or the new one, never an empty or half-written file.
 *
 * The temp name is fixed rather than random because only a mutex holder ever writes here,
 * so two writers cannot collide over it — which is what lets the old crash-orphaned temp
 * sweep go away entirely.
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
 * Remove the record, unconditionally. Safe ONLY because every removal happens under the
 * boot mutex, or behind a pid guard when the mutex could not be taken instantly — see
 * `daemon.ts`'s `cleanUp`. Without one of those, this is an unlink of whatever happens to
 * sit at the path right now, which may be a live daemon's fresh record.
 */
export function removeDaemonState(path: string): void {
  rmSync(path, { force: true })
}

/**
 * The boot/stop mutex path for a given pidfile. The `.lock` suffix has exactly one
 * definition in this package — here — and it must agree with `@tejika/env`'s
 * `getLockPath(app)`, which derives the same suffix from an app name rather than an
 * already-resolved `pidPath`. `@tejika/process` cannot use `getLockPath` directly
 * because it always works from a `pidPath` callers and tests may override.
 */
export function getLockPathFor(pidPath: string): string {
  return `${pidPath}.lock`
}
