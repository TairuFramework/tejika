import { dirname, join } from 'node:path'
import envPaths from 'env-paths'

import { appEnvVar, getAppEnvVar } from './env-var.js'

function assertNoSeparator(value: string, label: string): void {
  if (/[/\\]/.test(value) || value === '..') {
    throw new Error(`${label} must not contain a path separator or "..": "${value}"`)
  }
}

// unix `sun_path`: 104 bytes on darwin, 108 on linux/other. An over-length bind fails
// with a cryptic error, so surface it here with the limit and a remediation hint.
function assertSocketPathLength(app: string, path: string): void {
  const limit = process.platform === 'darwin' ? 104 : 108
  const bytes = Buffer.byteLength(path)
  if (bytes > limit) {
    throw new Error(
      `socket path ${bytes} bytes exceeds ${process.platform} limit of ${limit}: ${path}. ` +
        `Set ${appEnvVar(app, 'SOCKET_PATH')} to a shorter path.`,
    )
  }
}

export function getDataDir(app: string): string {
  return getAppEnvVar(app, 'DATA_DIR') ?? envPaths(app, { suffix: '' }).data
}

export function getStateDir(app: string): string {
  return getAppEnvVar(app, 'STATE_DIR') ?? envPaths(app, { suffix: '' }).config
}

/**
 * Log directory: the platform's own log location, not a subdirectory of the data dir.
 * `~/Library/Logs/<app>` on macOS, `$XDG_STATE_HOME/<app>` (`~/.local/state/<app>`) on Linux,
 * `AppData\Local\<app>\Log` on Windows.
 */
export function getLogDir(app: string): string {
  return getAppEnvVar(app, 'LOG_DIR') ?? envPaths(app, { suffix: '' }).log
}

export function getSocketPath(app: string, name?: string): string {
  assertNoSeparator(app, 'app')
  if (name != null) {
    assertNoSeparator(name, 'name')
  }
  const override = getAppEnvVar(app, 'SOCKET_PATH')
  let path: string
  if (override != null) {
    path = name == null ? override : join(dirname(override), `${name}.sock`)
  } else {
    path = join(getDataDir(app), name == null ? `${app}.sock` : `${name}.sock`)
  }
  assertSocketPathLength(app, path)
  return path
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
