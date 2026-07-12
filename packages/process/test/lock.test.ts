import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  claimDaemonLock,
  type LockRecord,
  readLockEntry,
  readLockRecord,
  reapLockFile,
} from '../src/lock.js'

let dir: string
let pidPath: string

// Runs on a real second thread: spin on the lockfile and count every moment it
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

const record = (over: Partial<LockRecord> = {}): LockRecord => ({
  pid: 1234,
  socketPath: '/tmp/app.sock',
  startedAt: 1_700_000_000_000,
  ready: false,
  ...over,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-lock-'))
  pidPath = join(dir, 'app.pid')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('claimDaemonLock', () => {
  test('claims a free path and writes the record', () => {
    const result = claimDaemonLock(pidPath, record())
    expect('lock' in result).toBe(true)
    expect(readLockRecord(pidPath)).toEqual(record())
  })

  test('a second claim on a held path returns the existing record and its inode', () => {
    claimDaemonLock(pidPath, record({ pid: 111 }))
    const inode = statSync(pidPath).ino
    const second = claimDaemonLock(pidPath, record({ pid: 222 }))
    expect(second).toEqual({ conflict: record({ pid: 111 }), inode })
    // The loser must not have overwritten the winner's record.
    expect(readLockRecord(pidPath)?.pid).toBe(111)
  })

  test('a corrupt existing file conflicts with a null record but still reports its inode', () => {
    writeFileSync(pidPath, 'not json at all', 'utf8')
    const inode = statSync(pidPath).ino
    expect(claimDaemonLock(pidPath, record())).toEqual({ conflict: null, inode })
  })

  test('leaves no temp files behind', () => {
    const first = claimDaemonLock(pidPath, record())
    if (!('lock' in first)) throw new Error('expected a claim')
    first.lock.markReady()
    claimDaemonLock(pidPath, record({ pid: 222 })) // a losing claim
    first.lock.release()
    expect(readdirSync(dir)).toEqual([])
  })

  // A SIGKILL between `writeTempRecord` and the `link`/`rename` orphans the temp
  // sibling forever: nothing else looks at it and `getDaemonStatus` cannot see it,
  // so a crash-looping daemon accumulates one per boot. Winning a claim is the one
  // moment we know the previous holder is gone, so that is when we sweep — but only
  // files old enough that no concurrent claimer could still be linking one.
  test('a won claim sweeps orphaned temp records, sparing fresh ones and other files', () => {
    const stale = `${pidPath}.999.deadbeef.tmp`
    const fresh = `${pidPath}.998.cafebabe.tmp`
    const unrelated = join(dir, 'app.sock')
    const otherPID = `${join(dir, 'other.pid')}.997.f00d.tmp`
    for (const path of [stale, fresh, unrelated, otherPID]) writeFileSync(path, 'x', 'utf8')
    // Older than the sweep's age floor: no live claim can still be linking these.
    const old = new Date(Date.now() - 60_000)
    utimesSync(stale, old, old)
    utimesSync(otherPID, old, old)

    const result = claimDaemonLock(pidPath, record())
    expect('lock' in result).toBe(true)

    expect(existsSync(stale)).toBe(false)
    // A racing claimer's temp file is mid-flight, not garbage.
    expect(existsSync(fresh)).toBe(true)
    // Neither the socket nor another daemon's temp file is ours to remove.
    expect(existsSync(unrelated)).toBe(true)
    expect(existsSync(otherPID)).toBe(true)
  })

  // The claim must be atomic to a READER, not just to a competing claimer. A
  // create-then-write claim leaves a zero-byte lockfile visible for microseconds;
  // a booter that reads it there parses nothing, classifies `not-running`, and
  // reaps the winner's fresh lock — the inode guard cannot help, it is the same
  // file. A real second thread hammers the path while this one claims, so the
  // window is genuinely observed rather than argued about.
  test('a concurrent reader never observes an empty or half-written lockfile', {
    timeout: 20_000,
  }, async () => {
    const stop = new SharedArrayBuffer(4)
    const flag = new Int32Array(stop)
    const reader = new Worker(READER_SOURCE, { eval: true, workerData: { pidPath, stop } })
    const observed = new Promise<{ bad: number; seen: number }>((resolve) => {
      reader.once('message', resolve)
    })
    await new Promise<void>((resolve) => reader.once('online', () => resolve()))

    // Synchronous on purpose: the reader is a separate OS thread, so it keeps
    // spinning through this loop and lands inside whatever window exists.
    let cycles = 0
    const until = Date.now() + 750
    while (Date.now() < until) {
      const result = claimDaemonLock(pidPath, record({ pid: process.pid }))
      if (!('lock' in result)) throw new Error('expected a claim')
      result.lock.markReady()
      result.lock.release()
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

describe('readLockRecord', () => {
  test('returns null when the file is absent', () => {
    expect(readLockRecord(join(dir, 'absent.pid'))).toBeNull()
  })

  test('readLockEntry pairs the record with the inode it was read from', () => {
    writeFileSync(pidPath, JSON.stringify(record()), 'utf8')
    expect(readLockEntry(pidPath)).toEqual({ record: record(), inode: statSync(pidPath).ino })
  })

  test('readLockEntry reports a null inode for an absent file', () => {
    expect(readLockEntry(join(dir, 'absent.pid'))).toEqual({ record: null, inode: null })
  })

  test('returns null for a record missing required fields', () => {
    writeFileSync(pidPath, JSON.stringify({ pid: 5 }), 'utf8')
    expect(readLockRecord(pidPath)).toBeNull()
  })

  test('returns null for a record with a non-numeric pid', () => {
    writeFileSync(pidPath, JSON.stringify({ ...record(), pid: 'abc' }), 'utf8')
    expect(readLockRecord(pidPath)).toBeNull()
  })

  // A non-positive pid is not a daemon, it is a weapon. `process.kill(0, sig)`
  // signals the WHOLE process group — the CLI that read this file included — and
  // `kill(-1, sig)` every process the user may signal. Both also pass a liveness
  // check (`kill(pid, 0)` succeeds), so such a record classified as a LIVE daemon
  // and walked straight into `stopDaemon`'s SIGTERM. The guard only demanded an
  // integer.
  test.each([0, -1, -12345])('returns null for a record with a pid of %i', (pid) => {
    writeFileSync(pidPath, JSON.stringify({ ...record(), pid }), 'utf8')
    expect(readLockRecord(pidPath)).toBeNull()
  })
})

describe('DaemonLock.markReady', () => {
  test('flips ready to true on disk and in the held record', () => {
    const result = claimDaemonLock(pidPath, record())
    if (!('lock' in result)) throw new Error('expected a claim')
    result.lock.markReady()
    expect(readLockRecord(pidPath)?.ready).toBe(true)
    expect(result.lock.record.ready).toBe(true)
  })

  test('rewrites the lockfile when a racing reaper removed it', () => {
    const result = claimDaemonLock(pidPath, record())
    if (!('lock' in result)) throw new Error('expected a claim')
    rmSync(pidPath)
    result.lock.markReady()
    expect(readLockRecord(pidPath)).toEqual(record({ ready: true }))
  })

  test('reclaims the lockfile when it was replaced by a foreign record', () => {
    const result = claimDaemonLock(pidPath, record({ pid: 111 }))
    if (!('lock' in result)) throw new Error('expected a claim')
    writeFileSync(pidPath, JSON.stringify(record({ pid: 999 })), 'utf8')
    result.lock.markReady()
    expect(readLockRecord(pidPath)?.pid).toBe(111)
  })
})

describe('DaemonLock.release', () => {
  test('removes our lockfile', () => {
    const result = claimDaemonLock(pidPath, record())
    if (!('lock' in result)) throw new Error('expected a claim')
    result.lock.release()
    expect(readLockRecord(pidPath)).toBeNull()
  })

  test('leaves a foreign record in place', () => {
    const result = claimDaemonLock(pidPath, record({ pid: 111 }))
    if (!('lock' in result)) throw new Error('expected a claim')
    writeFileSync(pidPath, JSON.stringify(record({ pid: 999 })), 'utf8')
    result.lock.release()
    expect(readLockRecord(pidPath)?.pid).toBe(999)
  })

  test('tolerates an already-removed lockfile', () => {
    const result = claimDaemonLock(pidPath, record())
    if (!('lock' in result)) throw new Error('expected a claim')
    rmSync(pidPath)
    expect(() => result.lock.release()).not.toThrow()
  })
})

describe('reapLockFile', () => {
  test('removes an existing lockfile and reports true', () => {
    writeFileSync(pidPath, JSON.stringify(record()), 'utf8')
    expect(reapLockFile(pidPath, statSync(pidPath).ino)).toBe(true)
    expect(readLockRecord(pidPath)).toBeNull()
  })

  test('reports false when the file is already gone', () => {
    expect(reapLockFile(pidPath, 1)).toBe(false)
  })

  test('refuses to remove a file whose inode is not the expected one', () => {
    writeFileSync(pidPath, JSON.stringify(record({ pid: 999 })), 'utf8')
    const actualInode = statSync(pidPath).ino
    // Simulates: we read record A, someone replaced the file, we try to reap A.
    expect(reapLockFile(pidPath, actualInode + 1)).toBe(false)
    expect(readLockRecord(pidPath)?.pid).toBe(999)
  })

  test('removes the file when the expected inode still matches', () => {
    writeFileSync(pidPath, JSON.stringify(record()), 'utf8')
    expect(reapLockFile(pidPath, statSync(pidPath).ino)).toBe(true)
    expect(readLockRecord(pidPath)).toBeNull()
  })
})
