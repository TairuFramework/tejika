import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LockRecord } from '@tejika/process'
import { describe, expect, test } from 'vitest'
import { waitForDaemonRunning, waitForDaemonStopped } from '../src/daemon.js'

let counter = 0
function makeDir(): string {
  const dir = join(tmpdir(), `tejika-daemon-wait-${process.pid}-${counter++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('waitForDaemonRunning', () => {
  test('resolves the pid once the pidfile names a live, running daemon', async () => {
    const dir = makeDir()
    const pidPath = join(dir, 'app.pid')
    const socketPath = join(dir, 'app.sock')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      const record: LockRecord = {
        pid: process.pid,
        socketPath,
        startedAt: Date.now(),
        ready: true,
      }
      writeFileSync(pidPath, JSON.stringify(record), 'utf8')
      await expect(waitForDaemonRunning({ pidPath, timeoutMs: 1_000 })).resolves.toBe(process.pid)
    } finally {
      server.close()
    }
  })

  test('does not resolve while the lockfile only reports booting', async () => {
    const dir = makeDir()
    const pidPath = join(dir, 'app.pid')
    // Claimed but not yet bound: `ready: false` with a fresh `startedAt`. A daemon
    // claims its lockfile before binding its socket, so `waitForDaemonRunning`
    // deliberately does not accept `booting` as proof of readiness.
    const record: LockRecord = {
      pid: process.pid,
      socketPath: join(dir, 'app.sock'),
      startedAt: Date.now(),
      ready: false,
    }
    writeFileSync(pidPath, JSON.stringify(record), 'utf8')
    await expect(waitForDaemonRunning({ pidPath, timeoutMs: 200 })).rejects.toThrow(
      /did not report running within 200ms/,
    )
  })

  test('throws on timeout when no pidfile appears', async () => {
    const pidPath = join(makeDir(), 'app.pid')
    await expect(waitForDaemonRunning({ pidPath, timeoutMs: 200 })).rejects.toThrow(
      /did not report running within 200ms/,
    )
  })
})

describe('waitForDaemonStopped', () => {
  test('returns once the pidfile names a dead process (stale record)', async () => {
    const pidPath = join(makeDir(), 'app.pid')
    const child = spawn('node', ['-e', ''])
    await once(child, 'exit')
    const pid = child.pid
    if (pid == null) throw new Error('expected spawned child to have a pid')
    const record: LockRecord = {
      pid,
      socketPath: join(tmpdir(), 'does-not-exist.sock'),
      startedAt: Date.now(),
      ready: true,
    }
    writeFileSync(pidPath, JSON.stringify(record), 'utf8')
    await expect(waitForDaemonStopped({ pidPath, timeoutMs: 1_000 })).resolves.toBeUndefined()
  })

  test('returns (not throws) on timeout while the process is still booting', async () => {
    const dir = makeDir()
    const pidPath = join(dir, 'app.pid')
    const record: LockRecord = {
      pid: process.pid,
      socketPath: join(dir, 'app.sock'),
      startedAt: Date.now(),
      ready: false,
    }
    writeFileSync(pidPath, JSON.stringify(record), 'utf8')
    await expect(waitForDaemonStopped({ pidPath, timeoutMs: 200 })).resolves.toBeUndefined()
  })
})
