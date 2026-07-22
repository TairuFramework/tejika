import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { getLockPath, getPIDPath } from '@tejika/env'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  type DaemonState,
  getLockPathFor,
  readDaemonState,
  removeDaemonState,
  writeDaemonState,
} from '../src/state.js'

let dir: string
let pidPath: string

// Runs on a real second thread: spin on the state file and count every moment it
// exists but does not parse. An absent file (between cycles) is fine and skipped.
const READER_SOURCE = `
const { readFileSync } = require('node:fs')
const { parentPort, workerData } = require('node:worker_threads')
const flag = new Int32Array(workerData.stop)
let bad = 0
let seen = 0
while (Atomics.load(flag, 0) === 0) {
  let raw
  try {
    raw = readFileSync(workerData.pidPath, 'utf8')
  } catch {
    continue
  }
  seen++
  try {
    if (typeof JSON.parse(raw).pid !== 'number') bad++
  } catch {
    bad++
  }
}
parentPort.postMessage({ bad, seen })
`

const state = (over: Partial<DaemonState> = {}): DaemonState => ({
  pid: 1234,
  socketPath: '/tmp/app.sock',
  startedAt: 1_700_000_000_000,
  ready: false,
  ...over,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-state-'))
  pidPath = join(dir, 'app.pid')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeDaemonState', () => {
  test('round-trips a record', () => {
    writeDaemonState(pidPath, state())
    expect(readDaemonState(pidPath)).toEqual(state())
  })

  test('replaces an existing record', () => {
    writeDaemonState(pidPath, state())
    writeDaemonState(pidPath, state({ ready: true }))
    expect(readDaemonState(pidPath)?.ready).toBe(true)
  })

  test('leaves no temp file behind', () => {
    writeDaemonState(pidPath, state())
    expect(existsSync(`${pidPath}.tmp`)).toBe(false)
  })

  // `getDaemonStatus` is a LOCK-FREE reader, so the write must be atomic to it even
  // though only a mutex holder ever writes. A create-then-write leaves an empty file
  // visible for microseconds; a reader that lands there parses nothing and concludes
  // "not running" about a live daemon. A real second thread hammers the path while
  // this one writes, so the window is genuinely observed rather than argued about.
  test('a concurrent reader never observes an empty or half-written record', {
    timeout: 20_000,
  }, async () => {
    const stop = new SharedArrayBuffer(4)
    const flag = new Int32Array(stop)
    const reader = new Worker(READER_SOURCE, { eval: true, workerData: { pidPath, stop } })
    const observed = new Promise<{ bad: number; seen: number }>((resolve) => {
      reader.once('message', resolve)
    })
    await new Promise<void>((resolve) => reader.once('online', () => resolve()))

    let cycles = 0
    const until = Date.now() + 750
    while (Date.now() < until) {
      writeDaemonState(pidPath, state({ pid: process.pid }))
      writeDaemonState(pidPath, state({ pid: process.pid, ready: true }))
      cycles++
    }
    Atomics.store(flag, 0, 1)

    const { bad, seen } = await observed
    await reader.terminate()

    expect(cycles).toBeGreaterThan(100)
    expect(seen).toBeGreaterThan(0)
    expect(bad).toBe(0)
  })
})

describe('readDaemonState', () => {
  test('returns null when the file is absent', () => {
    expect(readDaemonState(join(dir, 'absent.pid'))).toBeNull()
  })

  test('returns null for a corrupt file', () => {
    writeFileSync(pidPath, 'garbage', 'utf8')
    expect(readDaemonState(pidPath)).toBeNull()
  })

  test('returns null for a record missing required fields', () => {
    writeFileSync(pidPath, JSON.stringify({ pid: 5 }), 'utf8')
    expect(readDaemonState(pidPath)).toBeNull()
  })

  test('returns null for a record with a non-numeric pid', () => {
    writeFileSync(pidPath, JSON.stringify({ ...state(), pid: 'abc' }), 'utf8')
    expect(readDaemonState(pidPath)).toBeNull()
  })

  // A non-positive pid is not a daemon, it is a weapon. `process.kill(0, sig)` signals
  // the WHOLE process group — the CLI that read this file included — and `kill(-1, sig)`
  // every process the user may signal. Both also pass a liveness check (`kill(pid, 0)`
  // succeeds), so such a record classifies as a LIVE daemon and walks straight into
  // `stopDaemon`'s SIGTERM.
  test.each([0, -1, -12345])('returns null for a record with a pid of %i', (pid) => {
    writeFileSync(pidPath, JSON.stringify({ ...state(), pid }), 'utf8')
    expect(readDaemonState(pidPath)).toBeNull()
  })
})

describe('removeDaemonState', () => {
  test('removes the record', () => {
    writeDaemonState(pidPath, state())
    removeDaemonState(pidPath)
    expect(existsSync(pidPath)).toBe(false)
  })

  test('tolerates an already-removed record', () => {
    expect(() => removeDaemonState(pidPath)).not.toThrow()
  })
})

describe('getLockPathFor', () => {
  // The `.lock` suffix has exactly one definition in this package. Pin its agreement with
  // `@tejika/env`'s `getLockPath(app)` so the two cannot silently drift — a mismatched
  // `lockPath`/`pidPath` pair means no mutual exclusion at all.
  test("agrees with @tejika/env's getLockPath", () => {
    expect(getLockPathFor(getPIDPath('myapp'))).toBe(getLockPath('myapp'))
  })
})
