import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import envPaths from 'env-paths'

import { appEnvVar, getAppEnvVar } from './env-var.js'

function assertNoSeparator(value: string, label: string): void {
  if (/[/\\]/.test(value) || value === '..') {
    throw new Error(`${label} must not contain a path separator or "..": "${value}"`)
  }
}

/** Whether `path` is a Windows named pipe (`\\.\pipe\…` or `\\?\pipe\…`). */
export function isNamedPipe(path: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(path)
}

// unix `sun_path` is a 104-byte array on darwin, 108 on linux/other, and it must hold the
// terminating NUL — so the usable pathname is one byte shorter (103 / 107). An over-length
// bind fails with a cryptic error, so surface it here with the limit and a remediation hint.
function assertSocketPathLength(app: string, path: string): void {
  const limit = process.platform === 'darwin' ? 103 : 107
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

/**
 * Config directory (`envPaths(app).config`). `env-paths` has no state bucket, and its
 * `log` bucket is `~/Library/Logs` on macOS rather than a state dir, so the pidfile
 * lives here by design. Returns `<APP>_STATE_DIR` when set.
 */
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

/**
 * A win32 named pipe for `base`, scoped by a short stable hash of `anchor` (the POSIX-style
 * `.sock` path the same call resolves on POSIX). Named pipes live in one machine-global
 * namespace, so the base name alone would collide: two profiles selected by distinct
 * `DATA_DIR`/`SOCKET_PATH` overrides, or two users running the same app, would otherwise
 * share a pipe. Folding the resolved anchor in gives each its own.
 */
function namedPipeFor(base: string, anchor: string): string {
  const scope = createHash('sha256').update(anchor).digest('hex').slice(0, 12)
  const path = `\\\\.\\pipe\\${base}-${scope}`
  // Windows caps the whole `\\.\pipe\<name>` string (prefix included) at 256 characters.
  // Surface an over-length path here rather than deferring to an opaque `listen()` failure;
  // only the `base` (the app or socket name) is variable, since the hash is a fixed 12 chars.
  if (path.length > 256) {
    throw new Error(
      `named pipe path ${path.length} characters exceeds the Windows limit of 256: ${path}. ` +
        'Use a shorter app or socket name.',
    )
  }
  return path
}

/**
 * IPC endpoint for `app` (optionally a named sub-socket). On POSIX a `.sock` path under the
 * data dir; on win32 a `\\.\pipe\<base>-<hash>` named pipe. The `<APP>_SOCKET_PATH` override
 * is a directory anchor: with a `name` the endpoint is derived from `dirname(override)`; with
 * no `name` the override is used verbatim on both platforms. On win32 the pipe name folds in
 * a hash of the resolved anchor (data dir or override directory), so distinct profiles and
 * users do not collide in the global pipe namespace. `app`/`name` may not contain a path
 * separator or `..`. On POSIX an over-length path throws (`sun_path` holds 104/108 bytes
 * including the NUL, so the usable pathname limit is 103/107).
 */
export function getSocketPath(app: string, name?: string): string {
  assertNoSeparator(app, 'app')
  if (name != null) {
    assertNoSeparator(name, 'name')
  }
  const override = getAppEnvVar(app, 'SOCKET_PATH')
  if (process.platform === 'win32') {
    if (override != null && name == null) {
      return override
    }
    const anchor =
      override != null
        ? join(dirname(override), `${name}.sock`)
        : join(getDataDir(app), name == null ? `${app}.sock` : `${name}.sock`)
    return namedPipeFor(name ?? app, anchor)
  }
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
