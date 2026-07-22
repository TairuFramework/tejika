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

  // A foreign daemon holding the socket with no state record has no pid we can name. This
  // used to be reported as pid `-1` — a public error object handing the caller a weapon:
  // `process.kill(-1, sig)` signals every process the user may signal. An unknown pid is
  // now absent, and the message says so rather than printing a number that is not one.
  test('carries no pid when the running daemon cannot be named', () => {
    const err = new DaemonAlreadyRunningError(undefined, '/tmp/app.sock')
    expect(err.pid).toBeUndefined()
    expect(err.message).not.toContain('-1')
    expect(err.message).toContain('unknown pid')
    expect(err.socketPath).toBe('/tmp/app.sock')
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
