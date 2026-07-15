import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { acquireFileLock, TimeoutInterruption } from '@sozai/lock'
import { afterEach, beforeEach, expect, test } from 'vitest'

let dir: string
let lockPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-sozai-'))
  lockPath = join(dir, 'app.pid.lock')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// `close()` takes the mutex with `timeout: 0` precisely because it must never wait —
// a waiting acquire there deadlocks against a `stopDaemon` that is holding the mutex
// while waiting for this process to exit. This pins the semantics that makes it safe:
// a try-lock under contention FAILS FAST, and it fails with a distinguishable error.
//
// Both acquires below run in THIS process, so `acquireFileLock`'s in-memory per-process
// queue (`enterQueue`) already rejects the second one before `claimLockFile` — the
// filesystem `link()`/EEXIST path — is ever reached. That pins a real behaviour, but it
// is not the one `close()` depends on: see the cross-process test below for that.
test('a try-lock rejects a same-process holder without waiting', async () => {
  const held = await acquireFileLock(lockPath, { timeout: 0 })
  try {
    const started = Date.now()
    await expect(acquireFileLock(lockPath, { timeout: 0 })).rejects.toBeInstanceOf(
      TimeoutInterruption,
    )
    expect(Date.now() - started).toBeLessThan(500)
  } finally {
    held.release()
  }
})

// `close()`'s try-lock actually contends against a DIFFERENT OS process: `stopDaemon`,
// running in the CLI, holds the mutex while it waits for this daemon to exit. That
// contention never touches the in-memory queue above — it is decided entirely on disk,
// by `claimLockFile`'s `link()` hitting EEXIST against a live, non-stale holder, which
// falls out the bottom of `acquireFileLock`'s loop and throws from the try-lock branch.
// No lock is held in-process here, so `enterQueue`'s slot is free and this must reach
// that branch — pinning the fail-fast path `close()` actually depends on.
test('a try-lock rejects a live cross-process holder without waiting', async () => {
  // `process.pid` is guaranteed alive for the life of this test. `hostname` and `bootAt`
  // match this machine so `checkLiveness` treats the record as same-boot/same-namespace
  // and reaches the pid probe, which reports 'alive' — never stale, however long held.
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      nonce: 'live-holder',
      bootID: null,
      bootAt: Date.now() - uptime() * 1000,
      startedAt: Date.now(),
      uptimeAt: uptime() * 1000,
    }),
    'utf8',
  )
  const started = Date.now()
  await expect(acquireFileLock(lockPath, { timeout: 0 })).rejects.toBeInstanceOf(
    TimeoutInterruption,
  )
  expect(Date.now() - started).toBeLessThan(500)
})

test('a released lock is immediately re-acquirable', async () => {
  const first = await acquireFileLock(lockPath, { timeout: 0 })
  first.release()
  const second = await acquireFileLock(lockPath, { timeout: 0 })
  expect(second.path).toBe(lockPath)
  second.release()
})

// The wedge tejika depends on NOT happening: a booter SIGKILLed mid-boot leaves its
// lockfile behind, and the next boot must reap it on the holder's death rather than
// wait out the 60s stale timeout.
test('a lock whose holder is dead is reaped, not waited out', async () => {
  // A pid far above any live process, so kill(pid, 0) yields ESRCH. `hostname` and
  // `bootAt` are set to match this machine so `checkLiveness` treats the record as
  // same-boot/same-namespace and reaches the pid probe instead of bailing out as
  // 'unknown' (which would fall back to waiting out `staleTimeout` on the wall clock).
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 2 ** 22,
      hostname: hostname(),
      nonce: 'dead',
      bootID: null,
      bootAt: Date.now() - uptime() * 1000,
      startedAt: Date.now(),
      uptimeAt: uptime() * 1000,
    }),
    'utf8',
  )
  const started = Date.now()
  const lock = await acquireFileLock(lockPath, { timeout: 2_000 })
  expect(Date.now() - started).toBeLessThan(1_000)
  lock.release()
})
