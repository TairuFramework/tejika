import { join } from 'node:path'
import envPaths from 'env-paths'
import { getAppEnvVar } from './env-var.js'

export function getDataDir(app: string): string {
  return getAppEnvVar(app, 'DATA_DIR') ?? envPaths(app, { suffix: '' }).data
}

export function getStateDir(app: string): string {
  return getAppEnvVar(app, 'STATE_DIR') ?? envPaths(app, { suffix: '' }).config
}

export function getSocketPath(app: string, name?: string): string {
  const override = getAppEnvVar(app, 'SOCKET_PATH')
  if (override != null && name == null) return override
  const file = name == null ? `${app}.sock` : `${name}.sock`
  return join(getDataDir(app), file)
}

export function getPIDPath(app: string): string {
  return getAppEnvVar(app, 'PID_PATH') ?? join(getStateDir(app), `${app}.pid`)
}

/**
 * Daemon boot mutex, beside the pidfile. Derived, never separately configurable: a
 * `LOCK_PATH` override could resolve differently in a spawned child than its parent, and
 * two processes on different mutexes is the split brain the mutex exists to prevent.
 */
export function getLockPath(app: string): string {
  return `${getPIDPath(app)}.lock`
}
