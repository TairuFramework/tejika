import { afterEach, describe, expect, test } from 'vitest'

import {
  getDataDir,
  getLockPath,
  getLogDir,
  getPIDPath,
  getSocketPath,
  getStateDir,
} from '../src/paths.js'

afterEach(() => {
  delete process.env.MYAPP_DATA_DIR
  delete process.env.MYAPP_STATE_DIR
  delete process.env.MYAPP_LOG_DIR
  delete process.env.MYAPP_SOCKET_PATH
  delete process.env.MYAPP_PID_PATH
})

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
  test('derives a named socket from the override directory', () => {
    process.env.MYAPP_SOCKET_PATH = '/run/app.sock'
    expect(getSocketPath('myapp', 'monitor')).toBe('/run/monitor.sock')
  })
  test('override with no name is used verbatim', () => {
    process.env.MYAPP_SOCKET_PATH = '/run/app.sock'
    expect(getSocketPath('myapp')).toBe('/run/app.sock')
  })
})

describe('getSocketPath length guard', () => {
  const realPlatform = process.platform
  const setPlatform = (value: string) =>
    Object.defineProperty(process, 'platform', { value, configurable: true })
  afterEach(() => setPlatform(realPlatform))

  test('throws when the resolved path exceeds the darwin limit', () => {
    setPlatform('darwin')
    process.env.MYAPP_SOCKET_PATH = `/tmp/${'x'.repeat(110)}.sock`
    expect(() => getSocketPath('myapp')).toThrow(/exceeds darwin limit of 104/)
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
})

describe('getSocketPath on win32', () => {
  const realPlatform = process.platform
  const setPlatform = (value: string) =>
    Object.defineProperty(process, 'platform', { value, configurable: true })
  afterEach(() => setPlatform(realPlatform))

  test('returns an app-named pipe', () => {
    setPlatform('win32')
    expect(getSocketPath('myapp')).toBe('\\\\.\\pipe\\myapp')
  })
  test('returns a named pipe', () => {
    setPlatform('win32')
    expect(getSocketPath('myapp', 'monitor')).toBe('\\\\.\\pipe\\monitor')
  })
  test('honors an override with no name', () => {
    setPlatform('win32')
    process.env.MYAPP_SOCKET_PATH = '\\\\.\\pipe\\custom'
    expect(getSocketPath('myapp')).toBe('\\\\.\\pipe\\custom')
  })
  test('does not apply the posix length guard', () => {
    setPlatform('win32')
    expect(getSocketPath('myapp', 'x'.repeat(200))).toBe(`\\\\.\\pipe\\${'x'.repeat(200)}`)
  })
})
