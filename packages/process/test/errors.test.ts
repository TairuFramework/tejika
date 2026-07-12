import { describe, expect, test } from 'vitest'
import { DaemonAlreadyRunningError, DaemonBootError } from '../src/errors.js'

// `code` moved from a TS `readonly` field (a repo guardrail violation) to a
// `#code` + getter. It must stay a LITERAL-typed discriminant: this only compiles
// if `err.code === …` still narrows the union, so the typecheck is the assertion.
describe('the code discriminant', () => {
  test('narrows the union of daemon errors', () => {
    const errors: Array<DaemonAlreadyRunningError | DaemonBootError> = [
      new DaemonAlreadyRunningError(7, '/tmp/app.sock'),
      new DaemonBootError('boom', { logPath: '/tmp/daemon.log' }),
    ]
    for (const err of errors) {
      if (err.code === 'DAEMON_ALREADY_RUNNING') expect(err.pid).toBe(7)
      else expect(err.logPath).toBe('/tmp/daemon.log')
    }
  })
})

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
