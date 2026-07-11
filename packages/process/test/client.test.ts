import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createDaemonTransport, nextBackoff } from '../src/client.js'
import type { PingProtocol } from './fixtures/protocol.js'

const RECONNECT_MAX_MS = 5000

describe('nextBackoff', () => {
  test('the first backoff is a jittered value inside the base window', () => {
    expect(nextBackoff(0, () => 1)).toBe(250)
    expect(nextBackoff(0, () => 0.5)).toBe(125)
    expect(nextBackoff(0, () => 0)).toBe(0)
  })

  test('doubles the ceiling each time and caps it', () => {
    const top = () => 1
    const seen = [nextBackoff(0, top)]
    for (let i = 0; i < 7; i++) seen.push(nextBackoff(seen[seen.length - 1] as number, top))
    expect(seen.slice(0, 6)).toEqual([250, 500, 1000, 2000, 4000, 5000])
    expect(Math.max(...seen)).toBeLessThanOrEqual(RECONNECT_MAX_MS)
  })

  test('never returns a negative or NaN value', () => {
    for (const random of [0, 0.5, 1]) {
      const value = nextBackoff(1000, () => random)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(Number.isNaN(value)).toBe(false)
    }
  })
})

describe('createDaemonTransport', () => {
  let dir: string
  let socketPath: string
  let server: Server | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tejika-client-'))
    socketPath = join(dir, 'app.sock')
  })

  afterEach(async () => {
    if (server != null) await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  test('throws when nothing is listening', async () => {
    await expect(
      createDaemonTransport<PingProtocol>({ app: 'tejika-test', socketPath }),
    ).rejects.toThrow()
  })

  test('exposes the three Client hooks plus dispose', async () => {
    server = createServer()
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve))

    const daemonTransport = await createDaemonTransport<PingProtocol>({
      app: 'tejika-test',
      socketPath,
    })
    expect(daemonTransport.transport).toBeDefined()
    expect(typeof daemonTransport.handleTransportDisposed).toBe('function')
    expect(typeof daemonTransport.handleTransportError).toBe('function')

    // After dispose the hooks must stop handing out fresh transports, or
    // shutdown races a reconnect.
    daemonTransport.dispose()
    expect(daemonTransport.handleTransportDisposed()).toBeUndefined()
    expect(daemonTransport.handleTransportError()).toBeUndefined()
  })

  test('rejects promptly rather than hanging when the socket is absent', async () => {
    const started = Date.now()
    await expect(
      createDaemonTransport<PingProtocol>({
        app: 'tejika-test',
        socketPath,
        connectTimeoutMs: 200,
      }),
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
