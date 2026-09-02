import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  getDataDir,
  getLockPath,
  getLogDir,
  getPIDPath,
  getSocketPath,
  getStateDir,
  isNamedPipe,
} from '../src/paths.js'

afterEach(() => {
  delete process.env.MYAPP_DATA_DIR
  delete process.env.MYAPP_STATE_DIR
  delete process.env.MYAPP_LOG_DIR
  delete process.env.MYAPP_SOCKET_PATH
  delete process.env.MYAPP_PID_PATH
})

const realPlatform = process.platform
const setPlatform = (value: string) =>
  Object.defineProperty(process, 'platform', { value, configurable: true })
const restorePlatform = () => setPlatform(realPlatform)

// Pin a POSIX platform so `.sock`-shaped assertions are deterministic on the
// Windows CI runner, where the real platform would yield named-pipe paths.
// The win32 branch has its own dedicated `describe` below.
const pinPosix = () => {
  beforeEach(() => setPlatform('linux'))
  afterEach(restorePlatform)
}

describe('getDataDir', () => {
  test('returns a deterministic per-app data dir', () => {
    expect(getDataDir('myapp')).toMatch(/myapp/)
  })
  test('honors the env override first', () => {
    process.env.MYAPP_DATA_DIR = '/tmp/custom-data'
    expect(getDataDir('myapp')).toBe('/tmp/custom-data')
  })
})

describe('getStateDir', () => {
  test('returns a deterministic per-app state dir', () => {
    expect(getStateDir('myapp')).toMatch(/myapp/)
  })
  test('honors the env override first', () => {
    process.env.MYAPP_STATE_DIR = '/tmp/custom-state'
    expect(getStateDir('myapp')).toBe('/tmp/custom-state')
  })
})

describe('getLogDir', () => {
  test('returns a deterministic per-app log dir', () => {
    expect(getLogDir('myapp')).toMatch(/myapp/)
  })
  test('honors the env override first', () => {
    process.env.MYAPP_LOG_DIR = '/tmp/custom-logs'
    expect(getLogDir('myapp')).toBe('/tmp/custom-logs')
  })
  // `MYAPP_LOG_DIR= node …` defines the var as '' — must fall back, not return ''.
  test('falls back when the override is empty', () => {
    process.env.MYAPP_LOG_DIR = ''
    expect(getLogDir('myapp')).toMatch(/myapp/)
  })
})

describe('getPIDPath', () => {
  test('derives a pid path under the state dir', () => {
    expect(getPIDPath('myapp')).toMatch(/myapp.*\.pid$/)
  })
  test('honors the env override first', () => {
    process.env.MYAPP_PID_PATH = '/tmp/custom.pid'
    expect(getPIDPath('myapp')).toBe('/tmp/custom.pid')
  })
})

describe('getLockPath', () => {
  test('derives the lock path from the pid path', () => {
    expect(getLockPath('myapp')).toBe(`${getPIDPath('myapp')}.lock`)
  })

  // Derived, never separately configured: one override moves both, so a parent and
  // its spawned child can never resolve different mutexes.
  test('follows the pid path override', () => {
    process.env.MYAPP_PID_PATH = '/tmp/custom.pid'
    expect(getLockPath('myapp')).toBe('/tmp/custom.pid.lock')
  })
})

describe('getSocketPath', () => {
  pinPosix()
  test('derives a socket path under the data dir', () => {
    expect(getSocketPath('myapp')).toMatch(/myapp.*\.sock$/)
  })
  test('honors the env override first', () => {
    process.env.MYAPP_SOCKET_PATH = '/tmp/custom.sock'
    expect(getSocketPath('myapp')).toBe('/tmp/custom.sock')
  })
  test('supports a named socket', () => {
    expect(getSocketPath('myapp', 'monitor')).toMatch(/monitor\.sock$/)
  })
})

describe('getSocketPath input sanitization', () => {
  test('rejects a slash in name', () => {
    expect(() => getSocketPath('myapp', 'a/b')).toThrow(/path separator/)
  })
  test('rejects a backslash in name', () => {
    expect(() => getSocketPath('myapp', 'a\\b')).toThrow(/path separator/)
  })
  test('rejects a ".." name', () => {
    expect(() => getSocketPath('myapp', '..')).toThrow(/path separator|\.\./)
  })
  test('rejects a slash in app', () => {
    expect(() => getSocketPath('my/app')).toThrow(/path separator/)
  })
})

describe('empty override treated as unset', () => {
  pinPosix()
  // `MYAPP_DATA_DIR= node …` defines the var as '' — must fall back, not return ''.
  test('getDataDir falls back when override is empty', () => {
    process.env.MYAPP_DATA_DIR = ''
    expect(getDataDir('myapp')).toMatch(/myapp/)
  })
  test('getDataDir falls back when override is whitespace only', () => {
    process.env.MYAPP_DATA_DIR = '   '
    expect(getDataDir('myapp')).toMatch(/myapp/)
  })
  test('getSocketPath derives a path when override is empty', () => {
    process.env.MYAPP_SOCKET_PATH = ''
    expect(getSocketPath('myapp')).toMatch(/myapp.*\.sock$/)
  })
  test('getPIDPath derives a path when override is empty', () => {
    process.env.MYAPP_PID_PATH = ''
    expect(getPIDPath('myapp')).toMatch(/myapp.*\.pid$/)
  })
})

describe('getSocketPath override + name', () => {
  pinPosix()
  test('derives a named socket from the override directory', () => {
    process.env.MYAPP_SOCKET_PATH = '/run/app.sock'
    // `getSocketPath` derives via `node:path` `join`/`dirname`, which use the host
    // OS separator (`\` on the Windows runner) regardless of the mocked platform —
    // so compute the expected value the same way rather than hard-coding `/`.
    expect(getSocketPath('myapp', 'monitor')).toBe(join(dirname('/run/app.sock'), 'monitor.sock'))
  })
  test('override with no name is used verbatim', () => {
    process.env.MYAPP_SOCKET_PATH = '/run/app.sock'
    expect(getSocketPath('myapp')).toBe('/run/app.sock')
  })
})

describe('getSocketPath length guard', () => {
  afterEach(restorePlatform)

  test('throws when the resolved path exceeds the darwin limit', () => {
    setPlatform('darwin')
    process.env.MYAPP_SOCKET_PATH = `/tmp/${'x'.repeat(110)}.sock`
    expect(() => getSocketPath('myapp')).toThrow(/exceeds darwin limit of 103/)
  })
  test('names the override variable in the hint', () => {
    setPlatform('darwin')
    process.env.MYAPP_SOCKET_PATH = `/tmp/${'x'.repeat(110)}.sock`
    expect(() => getSocketPath('myapp')).toThrow(/MYAPP_SOCKET_PATH/)
  })
  test('allows a short path on linux', () => {
    setPlatform('linux')
    process.env.MYAPP_SOCKET_PATH = '/run/app.sock'
    expect(getSocketPath('myapp')).toBe('/run/app.sock')
  })
  // `sun_path` holds the terminating NUL, so a path filling the whole 104-byte array leaves
  // no room for it and fails to bind — the guard must reject at 104, not only above it.
  test('rejects a path of exactly 104 bytes on darwin', () => {
    setPlatform('darwin')
    const path = `/tmp/${'x'.repeat(94)}.sock`
    expect(Buffer.byteLength(path)).toBe(104)
    process.env.MYAPP_SOCKET_PATH = path
    expect(() => getSocketPath('myapp')).toThrow(/exceeds darwin limit of 103/)
  })
  test('allows a path of exactly 103 bytes on darwin', () => {
    setPlatform('darwin')
    const path = `/tmp/${'x'.repeat(93)}.sock`
    expect(Buffer.byteLength(path)).toBe(103)
    process.env.MYAPP_SOCKET_PATH = path
    expect(getSocketPath('myapp')).toBe(path)
  })
})

describe('isNamedPipe', () => {
  test('recognizes a Windows named pipe path', () => {
    expect(isNamedPipe('\\\\.\\pipe\\myapp')).toBe(true)
  })
  test('recognizes the `\\\\?\\pipe\\` form', () => {
    expect(isNamedPipe('\\\\?\\pipe\\myapp')).toBe(true)
  })
  test('rejects a POSIX socket path', () => {
    expect(isNamedPipe('/tmp/myapp.sock')).toBe(false)
  })
})

describe('getSocketPath on win32', () => {
  afterEach(restorePlatform)
  // A fixed data dir keeps the anchor (and thus the pipe hash) deterministic on a
  // non-Windows test host, where `envPaths` would otherwise resolve differently.
  beforeEach(() => {
    setPlatform('win32')
    process.env.MYAPP_DATA_DIR = 'C:\\data\\myapp'
  })

  test('returns an app-scoped pipe', () => {
    expect(getSocketPath('myapp')).toMatch(/^\\\\\.\\pipe\\myapp-[0-9a-f]{12}$/)
  })
  test('returns a name-scoped pipe', () => {
    expect(getSocketPath('myapp', 'monitor')).toMatch(/^\\\\\.\\pipe\\monitor-[0-9a-f]{12}$/)
  })
  test('honors an override with no name', () => {
    process.env.MYAPP_SOCKET_PATH = '\\\\.\\pipe\\custom'
    expect(getSocketPath('myapp')).toBe('\\\\.\\pipe\\custom')
  })
  test('does not apply the posix length guard', () => {
    expect(getSocketPath('myapp', 'x'.repeat(200))).toMatch(
      new RegExp(`^\\\\\\\\\\.\\\\pipe\\\\${'x'.repeat(200)}-[0-9a-f]{12}$`),
    )
  })
  test('rejects a pipe name over the Windows 256-character limit', () => {
    // 256 - 13 (the `-` plus the 12-char hash) = 243 is the longest base that fits.
    expect(() => getSocketPath('myapp', 'x'.repeat(244))).toThrow(
      /exceeds the Windows limit of 256/,
    )
  })
  // Named pipes are machine-global: distinct profiles/users must not resolve to the
  // same pipe just because they share an app or socket name.
  test('scopes the pipe name to the data dir so distinct profiles do not collide', () => {
    process.env.MYAPP_DATA_DIR = 'C:\\data\\profileA'
    const a = getSocketPath('myapp')
    process.env.MYAPP_DATA_DIR = 'C:\\data\\profileB'
    const b = getSocketPath('myapp')
    expect(a).not.toBe(b)
  })
  test('scopes a named pipe to the override directory', () => {
    // Forward-slash overrides so `node:path` `dirname` splits them the same way on
    // the non-Windows test host as it would on Windows.
    process.env.MYAPP_SOCKET_PATH = '/run/a/app.sock'
    const a = getSocketPath('myapp', 'monitor')
    process.env.MYAPP_SOCKET_PATH = '/run/b/app.sock'
    const b = getSocketPath('myapp', 'monitor')
    expect(a).not.toBe(b)
  })
})
