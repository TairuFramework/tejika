import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { claimDaemonLock, type LockRecord, readLockRecord, reapLockFile } from '../src/lock.js'

let dir: string
let pidPath: string

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
})

describe('readLockRecord', () => {
  test('returns null when the file is absent', () => {
    expect(readLockRecord(join(dir, 'absent.pid'))).toBeNull()
  })

  test('returns null for a record missing required fields', () => {
    writeFileSync(pidPath, JSON.stringify({ pid: 5 }), 'utf8')
    expect(readLockRecord(pidPath)).toBeNull()
  })

  test('returns null for a record with a non-numeric pid', () => {
    writeFileSync(pidPath, JSON.stringify({ ...record(), pid: 'abc' }), 'utf8')
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
    expect(reapLockFile(pidPath)).toBe(true)
    expect(readLockRecord(pidPath)).toBeNull()
  })

  test('reports false when the file is already gone', () => {
    expect(reapLockFile(pidPath)).toBe(false)
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
