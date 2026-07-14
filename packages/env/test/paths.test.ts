import { afterEach, describe, expect, test } from 'vitest'
import { getDataDir, getLockPath, getPIDPath, getSocketPath, getStateDir } from '../src/paths.js'

afterEach(() => {
  delete process.env.MYAPP_DATA_DIR
  delete process.env.MYAPP_STATE_DIR
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
