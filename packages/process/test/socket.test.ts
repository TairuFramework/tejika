import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createDeadline } from '../src/deadline.js'
import { isSocketLive, probeSocket, waitForSocket } from '../src/socket.js'

let dir: string
let socketPath: string
let server: Server | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-socket-'))
  socketPath = join(dir, 'app.sock')
})

afterEach(async () => {
  if (server != null) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
  rmSync(dir, { recursive: true, force: true })
})

const listen = async (): Promise<void> => {
  server = createServer()
  await new Promise<void>((resolve) => server?.listen(socketPath, resolve))
}

describe('probeSocket', () => {
  test('reports dead when nothing is listening', async () => {
    await expect(probeSocket(socketPath)).resolves.toBe('dead')
  })

  test('reports live when a server is listening', async () => {
    await listen()
    await expect(probeSocket(socketPath)).resolves.toBe('live')
  })
})

describe('isSocketLive', () => {
  test('is false for a missing socket', async () => {
    await expect(isSocketLive(socketPath)).resolves.toBe(false)
  })

  test('is true for a listening socket', async () => {
    await listen()
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
  })
})

describe('waitForSocket', () => {
  test('resolves once the socket accepts', async () => {
    setTimeout(() => void listen(), 20)
    await expect(
      waitForSocket(socketPath, { deadline: createDeadline(2000), interval: 10 }),
    ).resolves.toBeUndefined()
  })

  // The final sleep is `delay(min(interval, remaining()))`, which lands exactly on
  // the deadline — so the abort and the timer fire in the same tick and the abort
  // usually wins the race. Without the catch in `waitForSocket`, this test sees an
  // AbortError instead of the timeout, ~85% of runs. Run it a few times.
  test('rejects with the timeout error, not an AbortError, when the budget expires', async () => {
    await expect(
      waitForSocket(socketPath, { deadline: createDeadline(60), interval: 10 }),
    ).rejects.toThrow(/Timed out waiting for socket/)
  })

  test('propagates the caller AbortError, rather than reporting a timeout', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    // A generous budget, so `remaining() > 0` when the caller's signal fires.
    const promise = waitForSocket(socketPath, {
      deadline: createDeadline(5000, controller.signal),
      interval: 10,
    })
    await expect(promise).rejects.toThrow()
    await expect(promise).rejects.not.toThrow(/Timed out waiting for socket/)
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  // Deterministic sibling of the case above: the caller aborts DURING the probe
  // (an already-aborted signal), not during the sleep. On the first iteration the
  // top-of-loop guard sees the deadline aborted with budget still left. It must
  // NOT report a timeout — a guard keyed on `expired()` would; `timedOut()` does
  // not. No timing race, so this fails hard if the guard uses the wrong predicate.
  test('a caller abort during the probe propagates AbortError, never a timeout', async () => {
    const promise = waitForSocket(socketPath, {
      deadline: createDeadline(5000, AbortSignal.abort()),
      interval: 10,
    })
    await expect(promise).rejects.not.toThrow(/Timed out waiting for socket/)
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })
})
