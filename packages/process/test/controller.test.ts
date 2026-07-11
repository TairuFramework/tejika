import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ensureDaemon } from '../src/controller.js'
import { stopDaemon } from '../src/status.js'
import type { PingProtocol } from './fixtures/protocol.js'

const APP = 'tejika-test'
const entry = fileURLToPath(new URL('./fixtures/daemon-entry.ts', import.meta.url))
const hangEntry = fileURLToPath(new URL('./fixtures/hang-entry.ts', import.meta.url))
const env = { NODE_OPTIONS: '--import tsx' }

let dir: string
let socketPath: string
let pidPath: string
let logPath: string

const options = () => ({
  app: APP,
  entry,
  socketPath,
  pidPath,
  logPath,
  env,
  timeoutMs: 20_000,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-controller-'))
  socketPath = join(dir, 'app.sock')
  pidPath = join(dir, 'app.pid')
  logPath = join(dir, 'daemon.log')
})

afterEach(async () => {
  await stopDaemon({ app: APP, pidPath }).catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

test('spawns a daemon and returns a working client', { timeout: 30_000 }, async () => {
  const client = await ensureDaemon<PingProtocol>(options())
  await expect(client.request('ping')).resolves.toBe('pong')
  await client.dispose()
})

test('clears a stale socket file and boots anyway', { timeout: 30_000 }, async () => {
  writeFileSync(socketPath, '', 'utf8')
  const client = await ensureDaemon<PingProtocol>(options())
  await expect(client.request('ping')).resolves.toBe('pong')
  await client.dispose()
})

test('timeoutMs bounds the whole call, not just the connect retries', {
  timeout: 30_000,
}, async () => {
  const started = Date.now()
  await expect(
    ensureDaemon<PingProtocol>({ ...options(), entry: hangEntry, timeoutMs: 1500 }),
  ).rejects.toThrow()
  // Previously this took 3000ms (socket wait) + 5000ms (connect retry).
  expect(Date.now() - started).toBeLessThan(4000)
})

test('an aborted signal rejects promptly', { timeout: 30_000 }, async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  await expect(
    ensureDaemon<PingProtocol>({ ...options(), entry: hangEntry, signal: controller.signal }),
  ).rejects.toThrow()
})

// Ported from the deleted spawn.integration.test.ts: the reconnect path is
// covered nowhere else.
test('the client reconnects after the daemon is SIGKILLed and revived', {
  timeout: 60_000,
}, async () => {
  const client = await ensureDaemon<PingProtocol>(options())
  await expect(client.request('ping')).resolves.toBe('pong')

  const { pid } = JSON.parse(readFileSync(pidPath, 'utf8')) as { pid: number }
  process.kill(pid, 'SIGKILL')
  await delay(500)

  const revived = await ensureDaemon<PingProtocol>(options())

  let reconnected = false
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      if ((await client.request('ping')) === 'pong') {
        reconnected = true
        break
      }
    } catch {
      // mid-reconnect: the in-flight request aborts; keep polling.
    }
    await delay(250)
  }
  expect(reconnected).toBe(true)

  await client.dispose()
  await revived.dispose()
})
