import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { claimDaemonLock, type LockRecord, readLockRecord } from '../src/lock.js'
import type { SocketProbe } from '../src/socket.js'
import { classifyRecord, type StatusDeps, stopDaemon } from '../src/status.js'

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

describe('stopDaemon', () => {
  const APP = 'tejika-test'
  let dir: string
  let pidPath: string
  let socketPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tejika-status-'))
    pidPath = join(dir, 'app.pid')
    socketPath = join(dir, 'app.sock')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // Every reap in stopDaemon happens after `await`ing the status read, so the
  // lockfile it deletes may no longer be the one it classified. Here: a stale
  // lockfile is on disk; the stop reads it; before the stop resumes, a fresh
  // daemon reaps that stale file (correctly) and claims its own. An unguarded
  // reap deletes the NEW daemon's lock, leaving it running but invisible to
  // getDaemonStatus and unstoppable forever. `stopDaemon` calls `readLockEntry`
  // synchronously as it starts, so the interleaving below is exact, not timed.
  test('a stop racing a boot never deletes the lockfile of the new daemon', async () => {
    const deadPID = 2 ** 22
    writeFileSync(
      pidPath,
      JSON.stringify({ pid: deadPID, socketPath, startedAt: Date.now(), ready: true }),
      'utf8',
    )

    // X reads the stale record here, then yields at its first await.
    const stopping = stopDaemon({ app: APP, pidPath })

    // Y boots in that window: reaps the stale lock, claims a fresh one, binds,
    // marks ready. All synchronous, so it lands entirely inside X's await.
    rmSync(pidPath)
    const claim = claimDaemonLock(pidPath, {
      pid: process.pid,
      socketPath,
      startedAt: Date.now(),
      ready: false,
    })
    if (!('lock' in claim)) throw new Error('expected a claim')
    claim.lock.markReady()

    const result = await stopping
    expect(result).toEqual({ stopped: false, pid: deadPID, reason: 'not-running' })
    // Y's lockfile must survive: it is the only way anything can find Y again.
    expect(readLockRecord(pidPath)?.pid).toBe(process.pid)
  })

  test('a caller abort propagates the AbortError rather than reporting a timeout', async () => {
    // A child that ignores SIGTERM, so the exit poll is still running when the
    // caller aborts. `ready: false` inside the boot grace classifies as booting,
    // which stopDaemon signals exactly like running. It announces itself on stdout
    // only once the handler is installed — the `spawn` event fires before the
    // child has run a line of script, and a SIGTERM landing there still kills it.
    const child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready")'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    try {
      await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()))
      writeFileSync(
        pidPath,
        JSON.stringify({ pid: child.pid, socketPath, startedAt: Date.now(), ready: false }),
        'utf8',
      )

      const controller = new AbortController()
      setTimeout(() => controller.abort(), 100)
      const started = Date.now()
      const caught = await stopDaemon({
        app: APP,
        pidPath,
        killTimeoutMs: 10_000,
        signal: controller.signal,
      }).catch((err: unknown) => err)

      expect((caught as Error).name).toBe('AbortError')
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      child.kill('SIGKILL')
    }
  })
})
