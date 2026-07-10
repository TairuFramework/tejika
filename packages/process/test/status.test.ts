import { describe, expect, test } from 'vitest'
import type { LockRecord } from '../src/lock.js'
import type { SocketProbe } from '../src/socket.js'
import { classifyRecord, type StatusDeps } from '../src/status.js'

const NOW = 1_700_000_000_000
const OPTIONS = { bootGraceMs: 10_000, now: NOW }

const record = (over: Partial<LockRecord> = {}): LockRecord => ({
  pid: 1234,
  socketPath: '/tmp/app.sock',
  startedAt: NOW,
  ready: true,
  ...over,
})

const errno = (code: string): NodeJS.ErrnoException => {
  const err = new Error(code) as NodeJS.ErrnoException
  err.code = code
  return err
}

const throwing = (code: string) => (): never => {
  throw errno(code)
}

const deps = (over: Partial<StatusDeps> = {}): StatusDeps => ({
  kill: () => undefined,
  probe: async (): Promise<SocketProbe> => 'live',
  ...over,
})

describe('classifyRecord', () => {
  test('no record means not-running', async () => {
    await expect(classifyRecord(null, OPTIONS, deps())).resolves.toEqual({ state: 'not-running' })
  })

  test('ESRCH means stale', async () => {
    const result = await classifyRecord(record(), OPTIONS, deps({ kill: throwing('ESRCH') }))
    expect(result).toEqual({ state: 'stale', pid: 1234 })
  })

  test('EPERM means running-not-owned, never stale', async () => {
    const result = await classifyRecord(record(), OPTIONS, deps({ kill: throwing('EPERM') }))
    expect(result).toEqual({
      state: 'running-not-owned',
      pid: 1234,
      socketPath: '/tmp/app.sock',
    })
  })

  test('a live process with a live socket is running', async () => {
    const result = await classifyRecord(record(), OPTIONS, deps())
    expect(result).toEqual({ state: 'running', pid: 1234, socketPath: '/tmp/app.sock' })
  })

  test('a forbidden socket still counts as running', async () => {
    const result = await classifyRecord(record(), OPTIONS, deps({ probe: async () => 'forbidden' }))
    expect(result.state).toBe('running')
  })

  test('a live process whose socket is dead is a recycled pid: stale', async () => {
    const result = await classifyRecord(record(), OPTIONS, deps({ probe: async () => 'dead' }))
    expect(result).toEqual({ state: 'stale', pid: 1234 })
  })

  test('an unready record within the boot grace is booting', async () => {
    const result = await classifyRecord(
      record({ ready: false, startedAt: NOW - 5_000 }),
      OPTIONS,
      deps({ probe: async () => 'dead' }),
    )
    expect(result).toEqual({ state: 'booting', pid: 1234, socketPath: '/tmp/app.sock' })
  })

  test('an unready record past the boot grace is stale', async () => {
    const result = await classifyRecord(
      record({ ready: false, startedAt: NOW - 11_000 }),
      OPTIONS,
      deps({ probe: async () => 'dead' }),
    )
    expect(result).toEqual({ state: 'stale', pid: 1234 })
  })

  test('an unready record is not probed at all — probing would race the bind', async () => {
    let probed = false
    await classifyRecord(
      record({ ready: false, startedAt: NOW }),
      OPTIONS,
      deps({
        probe: async () => {
          probed = true
          return 'dead'
        },
      }),
    )
    expect(probed).toBe(false)
  })
})
