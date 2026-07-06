import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { waitForDaemonRunning, waitForDaemonStopped } from '../src/daemon.js'

let counter = 0
function makePidPath(): string {
  const dir = join(tmpdir(), `tejika-daemon-wait-${process.pid}-${counter++}`)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'app.pid')
}

describe('waitForDaemonRunning', () => {
  test('resolves the pid once the pidfile names a live process', async () => {
    const pidPath = makePidPath()
    writeFileSync(pidPath, String(process.pid))
    await expect(waitForDaemonRunning({ pidPath, timeoutMs: 1_000 })).resolves.toBe(process.pid)
  })

  test('throws on timeout when no pidfile appears', async () => {
    const pidPath = makePidPath()
    await expect(waitForDaemonRunning({ pidPath, timeoutMs: 200 })).rejects.toThrow(
      /did not report running within 200ms/,
    )
  })
})

describe('waitForDaemonStopped', () => {
  test('returns once the pidfile names a dead process', async () => {
    const pidPath = makePidPath()
    const child = spawn('node', ['-e', ''])
    await once(child, 'exit')
    writeFileSync(pidPath, String(child.pid))
    await expect(waitForDaemonStopped({ pidPath, timeoutMs: 1_000 })).resolves.toBeUndefined()
  })

  test('returns (not throws) on timeout while the process is still alive', async () => {
    const pidPath = makePidPath()
    writeFileSync(pidPath, String(process.pid))
    await expect(waitForDaemonStopped({ pidPath, timeoutMs: 200 })).resolves.toBeUndefined()
  })
})
