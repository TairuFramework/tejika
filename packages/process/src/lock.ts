import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

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

/** A record and the inode it was read from — captured together, from one descriptor. */
export type LockEntry = { record: LockRecord | null; inode: number | null }

function isLockRecord(value: unknown): value is LockRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.pid === 'number' &&
    Number.isInteger(record.pid) &&
    // A non-positive pid is not a daemon, it is a weapon: `process.kill(0, sig)`
    // signals the WHOLE process group — the CLI reading this lockfile included —
    // and `kill(-1, sig)` every process the user may signal. Worse, `kill(0, 0)`
    // succeeds, so such a record classifies as a LIVE daemon and walks straight
    // into `stopDaemon`'s SIGTERM. Refuse it here, where every reader passes:
    // a record that cannot be trusted is treated exactly like a corrupt one.
    record.pid > 0 &&
    typeof record.socketPath === 'string' &&
    typeof record.startedAt === 'number' &&
    typeof record.ready === 'boolean'
  )
}

function parseRecord(raw: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isLockRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Read the record and the inode it came from through a SINGLE open descriptor, so
 * the pair cannot straddle a replacement of the file. Callers that reap after an
 * await depend on that: the inode is what tells them the file they classified is
 * still the file they are about to unlink.
 */
export function readLockEntry(pidPath: string): LockEntry {
  let fd: number
  try {
    fd = openSync(pidPath, 'r')
  } catch {
    return { record: null, inode: null }
  }
  try {
    const inode = fstatSync(fd).ino
    return { record: parseRecord(readFileSync(fd, 'utf8')), inode }
  } catch {
    return { record: null, inode: null }
  } finally {
    closeSync(fd)
  }
}

/**
 * Read the record, or null when the file is absent, unreadable, or does not hold
 * a conforming record. Callers treat a corrupt record exactly as they treat a
 * missing one: stale.
 */
export function readLockRecord(pidPath: string): LockRecord | null {
  return readLockEntry(pidPath).record
}

function inodeOf(pidPath: string): number | null {
  try {
    return statSync(pidPath).ino
  } catch {
    return null
  }
}

/**
 * Write the record to a fresh sibling file. The full content exists before the
 * file is ever given a name a reader could look up, which is what makes both the
 * claim (`link`) and the update (`rename`) below atomic to any observer.
 */
function writeTempRecord(pidPath: string, record: LockRecord): string {
  const tmpPath = `${pidPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmpPath, JSON.stringify(record), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return tmpPath
}

/**
 * Old enough that no claim can still be mid-flight. Deliberately the same order as
 * `status.ts`'s boot grace, but a local constant: `status.ts` imports this module,
 * so importing it back would close an import cycle for a single number.
 */
const TEMP_RECORD_MAX_AGE_MS = 10_000

/**
 * Remove orphaned `.tmp` siblings. `writeTempRecord` then `link`/`rename` is only
 * atomic because the content exists under a throwaway name first — but a SIGKILL
 * landing in that window leaves the throwaway behind forever. Nothing else ever
 * looks at those files and `getDaemonStatus` cannot see them, so a crash-looping
 * daemon quietly accumulates them.
 *
 * Only files old enough that no live claim could still be linking one are touched,
 * so a concurrent claimer's fresh temp file is never pulled out from under it.
 * Best-effort throughout: a claim must never fail because tidying up did.
 */
function sweepTempRecords(pidPath: string): void {
  const prefix = `${basename(pidPath)}.`
  const cutoff = Date.now() - TEMP_RECORD_MAX_AGE_MS
  try {
    for (const name of readdirSync(dirname(pidPath))) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
      const tmpPath = join(dirname(pidPath), name)
      try {
        if (statSync(tmpPath).mtimeMs < cutoff) rmSync(tmpPath, { force: true })
      } catch {
        // Raced by another sweeper, or not ours to remove. Leave it.
      }
    }
  } catch {
    // An unreadable directory is not a reason to fail the claim we just won.
  }
}

/**
 * Unlink the lockfile only if its inode still matches `expectedInode`. Required,
 * not optional: an unguarded reap is an unlink of whatever happens to sit at the
 * path right now, which — after any await — may be a different daemon's live
 * lock. Read the inode with `readLockEntry` at the same moment you read the
 * record you are classifying. Returns whether the file was removed.
 */
export function reapLockFile(pidPath: string, expectedInode: number): boolean {
  if (inodeOf(pidPath) !== expectedInode) return false
  try {
    rmSync(pidPath)
    return true
  } catch {
    return false
  }
}

/**
 * Take an exclusive claim on `pidPath` via `link()` — the single atomic primitive
 * this design rests on. `link` fails with EEXIST when the name is taken, exactly
 * like `O_EXCL`, but the name it creates is already complete: the record is
 * written to a temp file first, so no racer can ever read the lockfile mid-write.
 * (A create-then-write claim leaves a zero-byte file visible for a moment; a
 * booter reading it there parses nothing, concludes "not-running", and reaps the
 * winner's fresh lock — the very check-then-act this design exists to remove.)
 *
 * The winner alone may touch the socket file; losers get the conflicting record
 * (or null when it is corrupt) with its inode, and must unlink nothing.
 */
export function claimDaemonLock(pidPath: string, record: LockRecord): ClaimResult {
  const held: LockRecord = { ...record }
  const tmpPath = writeTempRecord(pidPath, held)

  try {
    linkSync(tmpPath, pidPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    // The record and its inode come from one descriptor, so a caller reaping
    // after an await can detect a racer that replaced the file in the meantime.
    const entry = readLockEntry(pidPath)
    return { conflict: entry.record, inode: entry.inode }
  } finally {
    // The lockfile is a second link to the same inode; ours is now redundant.
    rmSync(tmpPath, { force: true })
  }

  // We won the claim: the one moment we know the previous holder is gone and can
  // safely tidy up the temp files its crash may have orphaned.
  sweepTempRecords(pidPath)

  return {
    lock: {
      record: held,
      markReady(): void {
        held.ready = true
        // Rename, not truncate-and-write: an observer sees the old record or the
        // new one, never an empty file. Unconditional, so it also recovers our
        // lockfile if a racing reaper removed it or wrote its own record over
        // ours. It replaces the inode, which only tightens the reap guard — a
        // reaper still holding our pre-ready inode now refuses to unlink us.
        const tmp = writeTempRecord(pidPath, held)
        try {
          renameSync(tmp, pidPath)
        } catch (err) {
          rmSync(tmp, { force: true })
          throw err
        }
      },
      release(): void {
        // Never remove a lockfile that is no longer ours.
        if (readLockRecord(pidPath)?.pid === held.pid) rmSync(pidPath, { force: true })
      },
    },
  }
}
