import { closeSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'

/**
 * The on-disk lock. `ready` is false between claiming the lock and binding the
 * socket: a concurrent observer must be able to tell "booting" from "crashed
 * after claiming", and only the record can carry that distinction.
 */
export type LockRecord = {
  pid: number
  socketPath: string
  startedAt: number
  ready: boolean
}

export type DaemonLock = {
  record: LockRecord
  /** Rewrite the record with `ready: true`, restoring it if a racing reaper removed it. */
  markReady(): void
  /** Unlink the lockfile, but only while it still holds our record. */
  release(): void
}

export type ClaimResult =
  | { lock: DaemonLock }
  | { conflict: LockRecord | null; inode: number | null }

function isLockRecord(value: unknown): value is LockRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.pid === 'number' &&
    Number.isInteger(record.pid) &&
    typeof record.socketPath === 'string' &&
    typeof record.startedAt === 'number' &&
    typeof record.ready === 'boolean'
  )
}

/**
 * Read the record, or null when the file is absent, unreadable, or does not hold
 * a conforming record. Callers treat a corrupt record exactly as they treat a
 * missing one: stale.
 */
export function readLockRecord(pidPath: string): LockRecord | null {
  let raw: string
  try {
    raw = readFileSync(pidPath, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return isLockRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function inodeOf(pidPath: string): number | null {
  try {
    return statSync(pidPath).ino
  } catch {
    return null
  }
}

function writeRecord(pidPath: string, record: LockRecord): void {
  writeFileSync(pidPath, JSON.stringify(record), 'utf8')
}

/**
 * Unlink the lockfile only if its inode still matches `expectedInode` (captured
 * now when omitted). Returns whether the file was removed.
 */
export function reapLockFile(pidPath: string, expectedInode?: number): boolean {
  const expected = expectedInode ?? inodeOf(pidPath)
  if (expected == null) return false
  if (inodeOf(pidPath) !== expected) return false
  try {
    rmSync(pidPath)
    return true
  } catch {
    return false
  }
}

/**
 * Take an exclusive claim on `pidPath` via `O_CREAT | O_EXCL` — the single atomic
 * primitive this design rests on. The winner alone may touch the socket file;
 * losers get the conflicting record (or null when it is corrupt) and must unlink
 * nothing.
 */
export function claimDaemonLock(pidPath: string, record: LockRecord): ClaimResult {
  let fd: number
  try {
    fd = openSync(pidPath, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    // Capture the record and the inode together, so a caller reaping after an
    // await can detect a racer that reclaimed the file in the meantime. The two
    // syscalls are adjacent — the residual window this design accepts.
    return { conflict: readLockRecord(pidPath), inode: inodeOf(pidPath) }
  }
  closeSync(fd)
  writeRecord(pidPath, record)

  const held: LockRecord = { ...record }

  return {
    lock: {
      record: held,
      markReady(): void {
        held.ready = true
        // Unconditional: this both flips `ready` and recovers our lockfile if a
        // racing reaper removed it or wrote its own record over ours.
        writeRecord(pidPath, held)
      },
      release(): void {
        // Never remove a lockfile that is no longer ours.
        if (readLockRecord(pidPath)?.pid === held.pid) rmSync(pidPath, { force: true })
      },
    },
  }
}
