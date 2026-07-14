import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { acquireFileLock } from '@sozai/lock'
import runCommand from 'nano-spawn'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { writeDaemonState } from '../src/state.js'
import { signalTolerantly, stopDaemon } from '../src/stop.js'

const APP = 'tejika-test'

const errno = (code: string): NodeJS.ErrnoException => {
  const err = new Error(code) as NodeJS.ErrnoException
  err.code = code
  return err
}

const throwing = (code: string) => (): never => {
  throw errno(code)
}

describe('stopDaemon', () => {
  let dir: string
  let pidPath: string
  let lockPath: string
  let socketPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tejika-stop-'))
    pidPath = join(dir, 'app.pid')
    lockPath = `${pidPath}.lock`
    socketPath = join(dir, 'app.sock')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('an absent state file is not-running', async () => {
    await expect(stopDaemon({ app: APP, pidPath })).resolves.toEqual({
      stopped: false,
      reason: 'not-running',
    })
  })

  // Under the mutex the removal needs no inode guard: nobody can write this file while
  // we hold the lock, so the record we classified is the record we remove.
  test('a stale state file is removed', async () => {
    const deadPID = 2 ** 22
    writeDaemonState(pidPath, { pid: deadPID, socketPath, startedAt: Date.now(), ready: true })
    await expect(stopDaemon({ app: APP, pidPath })).resolves.toEqual({
      stopped: false,
      pid: deadPID,
      reason: 'not-running',
    })
    expect(existsSync(pidPath)).toBe(false)
  })

  // A stop that cannot take the mutex has not failed and has not timed out waiting for a
  // daemon to die — someone else is booting or stopping this daemon and will not let go.
  // `stopDaemon` never throws, so `TimeoutInterruption` becomes a result.
  test('a held mutex resolves as busy, not as an error', async () => {
    const held = await acquireFileLock(lockPath, { timeout: 0 })
    try {
      writeDaemonState(pidPath, {
        pid: process.pid,
        socketPath,
        startedAt: Date.now(),
        ready: true,
      })
      await expect(stopDaemon({ app: APP, pidPath, lockTimeoutMs: 0 })).resolves.toEqual({
        stopped: false,
        reason: 'busy',
      })
      // Busy means we did nothing at all: the record must be untouched.
      expect(existsSync(pidPath)).toBe(true)
    } finally {
      held.release()
    }
  })

  // `process.kill(0, sig)` signals the ENTIRE process group and `kill(-1, sig)` every
  // process the user may signal. `isDaemonState` refuses a non-positive pid, so such a
  // record reads as no record at all. Run detached, in its own process group, so a
  // regression kills only the child.
  test('a state file naming pid 0 is refused, not signalled to the whole process group', {
    timeout: 30_000,
  }, async () => {
    const runner = fileURLToPath(new URL('./fixtures/stop-nonpositive-pid.ts', import.meta.url))
    const result = await runCommand('node', [runner, pidPath, socketPath], {
      env: { NODE_OPTIONS: '--import tsx' },
      detached: true,
    })
    expect(JSON.parse(result.stdout)).toEqual({ stopped: false, reason: 'not-running' })
  })

  // `stopDaemon` NEVER throws. No real errno other than ESRCH/EPERM can be provoked
  // against a valid pid, hence the injected `kill`.
  test('an unexpected errno from kill becomes a result, never a rejection', () => {
    const result = signalTolerantly(1234, 'SIGTERM', throwing('EINVAL'))
    expect(result).toEqual({
      stopped: false,
      pid: 1234,
      reason: 'error',
      error: expect.objectContaining({ code: 'EINVAL' }),
    })
  })

  // The signal was only ever consulted inside the exit poll — i.e. after the kill had
  // already gone out — so an already-aborted caller got `reason: 'aborted'` AND a dead
  // daemon. `runDaemon` refuses an aborted signal up-front; so must this.
  test('an already-aborted signal prevents the SIGTERM entirely', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    try {
      await new Promise<void>((resolve) => child.once('spawn', () => resolve()))
      writeDaemonState(pidPath, {
        pid: child.pid as number,
        socketPath,
        startedAt: Date.now(),
        ready: false,
      })

      const result = await stopDaemon({ app: APP, pidPath, signal: AbortSignal.abort() })

      expect(result).toEqual({ stopped: false, reason: 'aborted' })
      // The daemon must be untouched: an aborted caller asked for nothing to happen.
      await delay(200)
      expect(() => process.kill(child.pid as number, 0)).not.toThrow()
    } finally {
      child.kill('SIGKILL')
    }
  })

  // The happy path, with a child that is actually a daemon: it BINDS the socket its record
  // names, so the record is `ready: true` and `classifyState`'s socket probe corroborates
  // it as `running` — the one classification `stopDaemon` may signal. (An earlier version of
  // this test used a socket-less `setInterval` child under a `ready: false` record precisely
  // to dodge that probe, which is what let the `booting` fall-through below go unnoticed.)
  test('a live daemon is signalled, exits, and has its state file removed', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('listening'))`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    try {
      await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()))
      writeDaemonState(pidPath, {
        pid: child.pid as number,
        socketPath,
        startedAt: Date.now(),
        ready: true,
      })

      await expect(stopDaemon({ app: APP, pidPath })).resolves.toEqual({
        stopped: true,
        pid: child.pid,
      })
      expect(existsSync(pidPath)).toBe(false)
    } finally {
      child.kill('SIGKILL')
    }
  })

  // The regression. `stopLocked` HOLDS the mutex, and a `ready: false` record is only ever
  // written from inside that mutex — so one seen from in there was written by a process that
  // does not hold it, and is abandoned by construction. Its live pid is therefore NOT a
  // daemon: it is a recycled pid naming a stranger (the state file outlives a reboot, so a
  // daemon killed between its claim and its `ready: true` write leaves exactly this record
  // for the next `stop` to find). `stopDaemon` used to SIGTERM it, wait out `killTimeoutMs`,
  // and SIGKILL it. It must reap the record and signal nothing.
  test('a booting record is reaped, and its recycled pid is never signalled', async () => {
    // A live process that is not a daemon: exactly what a recycled pid looks like.
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    try {
      await new Promise<void>((resolve) => stranger.once('spawn', () => resolve()))
      const pid = stranger.pid as number
      writeDaemonState(pidPath, { pid, socketPath, startedAt: Date.now(), ready: false })

      await expect(stopDaemon({ app: APP, pidPath })).resolves.toEqual({
        stopped: false,
        pid,
        reason: 'not-running',
      })
      expect(existsSync(pidPath)).toBe(false)
      // The point of the test: no SIGTERM went out, so the stranger is untouched.
      await delay(200)
      expect(() => process.kill(pid, 0)).not.toThrow()
    } finally {
      stranger.kill('SIGKILL')
    }
  })

  test('a caller abort resolves with reason: aborted rather than throwing or reporting a timeout', async () => {
    // A real daemon — it binds the socket its record names, so it classifies as `running`
    // and is signalled — that IGNORES SIGTERM, so the exit poll is still running when the
    // caller aborts. It announces itself on stdout only once it is listening and the handler
    // is installed: the `spawn` event fires before the child has run a line of script.
    const child = spawn(
      process.execPath,
      [
        '-e',
        `process.on("SIGTERM", () => {}); require('net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('listening'))`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    try {
      await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()))
      writeDaemonState(pidPath, {
        pid: child.pid as number,
        socketPath,
        startedAt: Date.now(),
        ready: true,
      })

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
