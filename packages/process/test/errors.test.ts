import { describe, expect, test } from 'vitest'
import { DaemonAlreadyRunningError, DaemonBootError } from '../src/errors.js'

describe('DaemonAlreadyRunningError', () => {
  test('carries the pid, socket path, and a stable code', () => {
    const err = new DaemonAlreadyRunningError(4321, '/tmp/app.sock')
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('DAEMON_ALREADY_RUNNING')
    expect(err.pid).toBe(4321)
    expect(err.socketPath).toBe('/tmp/app.sock')
    expect(err.message).toContain('4321')
    expect(err.name).toBe('DaemonAlreadyRunningError')
  })
})

describe('DaemonBootError', () => {
  test('carries the log path and preserves the cause', () => {
    const cause = new Error('exit 1')
    const err = new DaemonBootError('daemon exited during boot', {
      logPath: '/tmp/daemon.log',
      cause,
    })
    expect(err.code).toBe('DAEMON_BOOT_FAILED')
    expect(err.logPath).toBe('/tmp/daemon.log')
    expect(err.cause).toBe(cause)
    expect(err.message).toContain('/tmp/daemon.log')
    expect(err.name).toBe('DaemonBootError')
  })
})
