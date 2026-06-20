import { afterEach, describe, expect, test } from 'vitest'
import { getDataDir, getPidPath, getSocketPath, getStateDir } from '../src/paths.js'

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

describe('getPidPath', () => {
  test('derives a pid path under the state dir', () => {
    expect(getPidPath('myapp')).toMatch(/myapp.*\.pid$/)
  })
  test('honors the env override first', () => {
    process.env.MYAPP_PID_PATH = '/tmp/custom.pid'
    expect(getPidPath('myapp')).toBe('/tmp/custom.pid')
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
