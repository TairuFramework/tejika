import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import runCommand from 'nano-spawn'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { claimDaemonLock, type LockRecord, readLockRecord } from '../src/lock.js'
import type { SocketProbe } from '../src/socket.js'
import { classifyRecord, type StatusDeps, signalTolerantly, stopDaemon } from '../src/status.js'

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

  // `process.kill(0, sig)` signals the ENTIRE process group and `kill(-1, sig)`
  // every process the user may signal. `isLockRecord` only required an INTEGER pid,
  // so a lockfile with `pid: 0` classified as alive (`kill(0, 0)` succeeds) and,
  // inside the boot grace, as `booting` — which `stopDaemon` signals exactly like
  // `running`. The SIGTERM then killed the caller's own process group: the CLI.
  //
  // Run detached, in its own process group, so a regression kills only the child.
  test('a lockfile naming pid 0 is refused, not signalled to the whole process group', {
    timeout: 30_000,
  }, async () => {
    const runner = fileURLToPath(new URL('./fixtures/stop-nonpositive-pid.ts', import.meta.url))
    const result = await runCommand('node', [runner, pidPath, socketPath], {
      env: { NODE_OPTIONS: '--import tsx' },
      detached: true,
    })
    // Pre-fix the child never got here: it died by SIGTERM, and `runCommand`
    // rejected. A non-positive pid is not a daemon — it reads as no daemon at all.
    expect(JSON.parse(result.stdout)).toEqual({ stopped: false, reason: 'not-running' })
  })

  // `stopDaemon` NEVER throws. The first SIGTERM used to sit OUTSIDE the try that
  // catches, and `signalTolerantly` rethrew any errno other than ESRCH/EPERM — so
  // an unexpected errno escaped as a rejection. No real errno other than those two
  // can be provoked against a valid pid, hence the injected `kill`.
  test('an unexpected errno from kill becomes a result, never a rejection', () => {
    const result = signalTolerantly(1234, 'SIGTERM', throwing('EINVAL'))
    expect(result).toEqual({
      stopped: false,
      pid: 1234,
      reason: 'error',
      error: expect.objectContaining({ code: 'EINVAL' }),
    })
  })

  // The signal was only ever consulted inside the exit poll — i.e. after the kill
  // had already gone out — so an already-aborted caller got `reason: 'aborted'` AND
  // a dead daemon. `runDaemon` refuses an aborted signal up-front; so must this.
  test('an already-aborted signal prevents the SIGTERM entirely', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    try {
      await new Promise<void>((resolve) => child.once('spawn', () => resolve()))
      writeFileSync(
        pidPath,
        JSON.stringify({ pid: child.pid, socketPath, startedAt: Date.now(), ready: false }),
        'utf8',
      )

      const result = await stopDaemon({
        app: APP,
        pidPath,
        signal: AbortSignal.abort(),
      })

      expect(result).toEqual({ stopped: false, reason: 'aborted' })
      // The daemon must be untouched: an aborted caller asked for nothing to happen.
      expect(child.killed).toBe(false)
      expect(child.exitCode).toBeNull()
    } finally {
      child.kill('SIGKILL')
    }
  })

  // The reap was guarded by the inode captured with the record we classified. But a
  // daemon stopped while `booting` may reach `markReady()` first — a RENAME, so a
  // NEW inode — and the guard then matched nothing: the reap no-opped and
  // `{ stopped: true }` was returned over a lockfile still naming the dead pid.
  test('a daemon that marks ready mid-stop still has its lockfile reaped', {
    timeout: 30_000,
  }, async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    await new Promise<void>((resolve) => child.once('spawn', () => resolve()))
    const pid = child.pid as number
    writeFileSync(
      pidPath,
      JSON.stringify({ pid, socketPath, startedAt: Date.now(), ready: false }),
      'utf8',
    )

    // The stop reads the record (and its inode) synchronously, then yields.
    const stopping = stopDaemon({ app: APP, pidPath, killTimeoutMs: 10_000 })

    // The daemon finishes booting inside that window: markReady() writes a fresh
    // sibling and renames it over the lockfile — same pid, NEW inode.
    const tmpPath = `${pidPath}.tmp`
    writeFileSync(
      tmpPath,
      JSON.stringify({ pid, socketPath, startedAt: Date.now(), ready: true }),
      'utf8',
    )
    renameSync(tmpPath, pidPath)

    const result = await stopping
    expect(result).toEqual({ stopped: true, pid })
    // `{ stopped: true }` with a lockfile naming a dead pid still on disk is a lie.
    expect(existsSync(pidPath)).toBe(false)
  })

  test('a caller abort resolves with reason: aborted rather than throwing or reporting a timeout', async () => {
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
      const result = await stopDaemon({
        app: APP,
        pidPath,
        killTimeoutMs: 10_000,
        signal: controller.signal,
      })

      expect(result).toEqual({ stopped: false, pid: child.pid, reason: 'aborted' })
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      child.kill('SIGKILL')
    }
  })
})
