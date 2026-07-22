import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireFileLock } from '@sozai/lock'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import type { SocketProbe } from '../src/socket.js'
import { type DaemonState, writeDaemonState } from '../src/state.js'
import { classifyState, getDaemonStatus, type StatusDeps } from '../src/status.js'

const NOW = 1_700_000_000_000

const state = (over: Partial<DaemonState> = {}): DaemonState => ({
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

describe('classifyState', () => {
  test('no record means not-running', async () => {
    await expect(classifyState(null, deps())).resolves.toEqual({ state: 'not-running' })
  })

  test('ESRCH means stale', async () => {
    await expect(classifyState(state(), deps({ kill: throwing('ESRCH') }))).resolves.toEqual({
      state: 'stale',
      pid: 1234,
    })
  })

  test('EPERM means running-not-owned, never stale', async () => {
    await expect(classifyState(state(), deps({ kill: throwing('EPERM') }))).resolves.toEqual({
      state: 'running-not-owned',
      pid: 1234,
      socketPath: '/tmp/app.sock',
    })
  })

  test('a live process with a live socket is running', async () => {
    await expect(classifyState(state(), deps())).resolves.toEqual({
      state: 'running',
      pid: 1234,
      socketPath: '/tmp/app.sock',
    })
  })

  test('a forbidden socket still counts as running', async () => {
    const result = await classifyState(state(), deps({ probe: async () => 'forbidden' }))
    expect(result.state).toBe('running')
  })

  test('a live process whose socket is dead is a recycled pid: stale', async () => {
    await expect(classifyState(state(), deps({ probe: async () => 'dead' }))).resolves.toEqual({
      state: 'stale',
      pid: 1234,
    })
  })

  // `booting` is now an OBSERVER state only, and it has no clock. The old ten-second boot
  // grace decided how long an unready record stayed `booting` before it became `stale`;
  // the boot mutex decides that now, and it decides it by proof: a `ready: false` record
  // read while HOLDING the mutex was written by a process that does not hold it, so it is
  // abandoned. An observer (this function) neither holds the mutex nor needs to guess.
  test('an unready record with a live pid is booting, however old it is', async () => {
    const ancient = state({ ready: false, startedAt: NOW - 3_600_000 })
    await expect(classifyState(ancient, deps())).resolves.toEqual({
      state: 'booting',
      pid: 1234,
      socketPath: '/tmp/app.sock',
    })
  })

  test('an unready record is not probed at all — probing would race the bind', async () => {
    let probed = false
    await classifyState(
      state({ ready: false }),
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

describe('getDaemonStatus', () => {
  let dir: string
  let pidPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tejika-status-'))
    pidPath = join(dir, 'app.pid')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('an absent state file is not-running', async () => {
    await expect(getDaemonStatus({ app: 'tejika-test', pidPath })).resolves.toEqual({
      state: 'not-running',
    })
  })

  test('a record naming a dead process is stale', async () => {
    // A pid far above any live process, so kill(pid, 0) yields ESRCH.
    writeDaemonState(pidPath, state({ pid: 2 ** 22, startedAt: Date.now() }))
    await expect(getDaemonStatus({ app: 'tejika-test', pidPath })).resolves.toEqual({
      state: 'stale',
      pid: 2 ** 22,
    })
  })

  // Reading must never mutate: a stale record is the boot path's to reap, under the mutex.
  test('is pure — a stale record survives being classified', async () => {
    writeDaemonState(pidPath, state({ pid: 2 ** 22, startedAt: Date.now() }))
    await getDaemonStatus({ app: 'tejika-test', pidPath })
    await expect(getDaemonStatus({ app: 'tejika-test', pidPath })).resolves.toEqual({
      state: 'stale',
      pid: 2 ** 22,
    })
  })

  // Load-bearing for `stopDaemon`/`runDaemon`: `getDaemonStatus` must never block behind a
  // boot. An implementation that wrapped it in `withFileLock` would pass every other test
  // here while deadlocking against a held mutex, so pin it directly: hold the lock, then
  // assert the call still resolves promptly.
  test('never blocks behind a held boot/stop mutex', async () => {
    const held = await acquireFileLock(`${pidPath}.lock`, { timeout: 0 })
    try {
      writeDaemonState(pidPath, state({ pid: 2 ** 22, startedAt: Date.now() }))
      const started = Date.now()
      await expect(getDaemonStatus({ app: 'tejika-test', pidPath })).resolves.toEqual({
        state: 'stale',
        pid: 2 ** 22,
      })
      expect(Date.now() - started).toBeLessThan(500)
    } finally {
      held.release()
    }
  })
})
