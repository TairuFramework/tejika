# Migrate daemon locking to `@sozai/lock`

**Status:** approved design
**Branch:** `feat/sozai-lock`
**Affects:** `@tejika/process`, `@tejika/env`

## Problem

`packages/process/src/lock.ts` is not a mutex. It is a daemon *presence record* that
doubles as one: the on-disk record carries application payload (`socketPath`, `ready`),
it is held for the daemon's entire lifetime, it is read by observers who never intend to
acquire it (`getDaemonStatus`), and a process that loses the claim never waits — it
throws `DaemonAlreadyRunningError`.

Because there is no mutex, every boot and every stop is a check-then-act against the
filesystem. The code that makes those races safe — `claimDaemonLock`'s `link()` dance,
inode-guarded reaps, temp-record sweeping, the three-attempt claim retry loop, the
`reap(pid)` closure in `stopDaemon` — is the most subtle code in the repository, and it
carries a real bug:

> `reapLockFile(pidPath, expectedInode)` guards the unlink on the inode alone. The kernel
> recycles an inode number the moment a file is unlinked, so on Linux the lock claimed
> right after a stale one is reaped routinely lands on the very inode the reaper is
> holding as its "stale" identity. The reaper then unlinks a live daemon's fresh lock.

`@sozai/lock` was extracted from this code and fixed exactly that, with a per-claim
`nonce` the inode cannot fake, plus an OS boot ID so a pid is only trusted when it comes
from this boot. Tejika has neither.

## Approach

`@sozai/lock` becomes a **short-lived mutex** around the boot, stop, and close critical
sections. Daemon presence moves to a **separate state file** that tejika reads and writes
itself.

Every check-then-act race collapses into "hold the mutex". Sozai stays a mutex — its
stated axiom, *"never key material, never caller payload"*, is not broken. Tejika stays
the daemon-domain expert: the socket probe is its liveness proof, and no mutex should
know about sockets.

**No changes to `@sozai/lock` are required.** Tejika uses only its existing exports:
`acquireFileLock`, `withFileLock`, `TimeoutInterruption`, `FileLock`, `FileLockOptions`.

Two approaches were rejected:

- **Payload lock** — extend sozai upstream with a generic `data` payload, a
  `readLockHolder` observer, and a staleness hook so tejika could inject the socket probe.
  Breaks sozai's payload axiom and gives a mutex a second staleness authority it has no
  business having.
- **Hybrid** — sozai adds payload plus observer; tejika force-breaks the lock when its own
  staleness (dead socket) disagrees with sozai's (live pid). Upstream churn *and* two
  competing staleness authorities.

## Module layout

```
packages/process/src/
  state.ts     NEW      DaemonState type, read/write/remove. No claiming, no reaping.
  status.ts   SHRINKS   classify + getDaemonStatus only
  stop.ts      NEW      stopDaemon + signalTolerantly + pollUntilGone
  daemon.ts   CHANGES   boot critical section under the mutex
  spawn.ts    CHANGES   readDaemonState / classifyState
  lock.ts     DELETED
```

`status.ts` is 270 lines doing two jobs — classifying the daemon and killing it.
`stopDaemon` now needs both the lock and the state module, so the split pays for itself.

## Paths

The lock sits next to the state file, derived, never configured separately:

```ts
// @tejika/env
export function getLockPath(app: string): string {
  return `${getPIDPath(app)}.lock`
}
```

`getPIDPath` keeps its name, its path, its env override, its `.pid` extension, and its
JSON contents. The file still *is* the pidfile; it merely stops doubling as the mutex.
`--pid-path`, `RunDaemonOptions.pidPath`, and `@tejika/test`'s
`waitForDaemonRunning({ pidPath })` are all untouched.

Internally `lockPath` defaults to `` `${pidPath}.lock` ``, so `spawnDaemon` needs no new
CLI flag. This deliberately avoids a second instance of the parent/child path-divergence
hazard documented at `spawn.ts:68`, where a `@tejika/env` override could resolve
differently in the child. No new environment variable.

## `state.ts`

```ts
export type DaemonState = {
  pid: number
  socketPath: string
  startedAt: number
  ready: boolean
}

export function readDaemonState(path: string): DaemonState | null
export function writeDaemonState(path: string, state: DaemonState): void
export function removeDaemonState(path: string): void
```

Writes stay atomic — temp file, then `rename` — because `getDaemonStatus` is a **lock-free**
reader and must never see a torn file. But the temp file can now use a single fixed name
(`<path>.tmp`, flag `w`) rather than a random one: only one process writes at a time, since
every writer holds the mutex. That deletes `sweepTempRecords`, its filename regex, its
cutoff constant, and the crash-orphan problem it existed to manage.

Deleted with `lock.ts`: `claimDaemonLock`, `readLockEntry`, `reapLockFile`, `LockEntry`,
`ClaimResult`, `LockRecord`, the `link()` claim, and every inode guard. They existed only
to make check-then-act safe without a mutex.

Kept verbatim: the `pid > 0` validation and its comment. It is a security guard —
`process.kill(0, sig)` signals the entire process group and `kill(-1, sig)` every process
the user may signal — and it must survive the migration intact.

`removeDaemonState` is unconditional. That is safe only because every removal happens
under the lock.

## Boot

`claimOrThrow`, `CLAIM_ATTEMPTS`, and the reap-and-retry loop are deleted. The mutex
serializes, so there is nothing to retry.

```ts
using lock = await acquireFileLock(lockPath, { timeout: lockTimeoutMs, signal: opts.signal })

const status = await classifyState(readDaemonState(pidPath))
if (status.state === 'running' || status.state === 'running-not-owned') {
  throw new DaemonAlreadyRunningError(status.pid, socketPath)
}
// not-running | stale | booting are ALL free to take.
if (existsSync(socketPath)) {
  if (await isSocketLive(socketPath)) throw new DaemonAlreadyRunningError(-1, socketPath)
  safeRemove(socketPath)
}
const claimed = { pid: process.pid, socketPath, startedAt: Date.now(), ready: false }
writeDaemonState(pidPath, claimed)
await bind()
writeDaemonState(pidPath, { ...claimed, ready: true })
```

The load-bearing line is `booting` being free to take. A `ready: false` record is only ever
written inside this section, by a process holding the mutex. We hold the mutex. Therefore
its writer does not, therefore it is abandoned. That is a proof, not a guess.

**This deletes `bootGraceMs` and `DEFAULT_BOOT_GRACE_MS`.** Today's ten-second grace is a
guess that fails in both directions: too short and it steals the socket from a live-but-slow
booter, which is a split brain; too long and it blocks a legitimate boot behind a corpse.

`booting` survives as an *observer* state only (`ready: false` plus a live pid), which is
what `spawn.ts`'s loser-concedes check reads.

## Stop

The whole classify → SIGTERM → poll → SIGKILL → remove sequence moves inside `withFileLock`.

That deletes the `reap(pid)` closure with its captured inode, its re-read, and its "or a
rewrite of it that still names the pid we stopped" fallback. No racer can touch the state
file while we hold the lock, so it collapses to `removeDaemonState(pidPath)`.

A stop can hold the mutex for `killTimeoutMs` plus the SIGKILL grace — roughly seven
seconds. A concurrent `runDaemon` blocks on acquire for that long, which is correct: it
should wait for the stop to finish rather than race it.

`stopDaemon` never throws, so a failed acquire must become a result. `TimeoutInterruption`
becomes a new `reason: 'busy'`; anything else, such as `EACCES`, is the existing
`reason: 'error'` with the cause attached.

## Close

The daemon does **not** hold the mutex while serving — it released it at the end of boot.
So `DaemonHandle.close()` retakes it before removing the socket and the state file, or it
can delete a newcomer's fresh record.

It retakes it with a **try-lock**, never a waiting acquire:

```ts
await closeServer(server, connections)
await opts.onShutdown?.()

let lock: FileLock | null = null
try {
  lock = await acquireFileLock(lockPath, { timeout: 0 })
} catch {
  // Someone else holds it. The pid guard below still applies.
}
try {
  if (readDaemonState(pidPath)?.pid === process.pid) {
    safeRemove(socketPath)
    removeDaemonState(pidPath)
  }
} finally {
  lock?.release()
}
```

A *waiting* acquire here deadlocks against `stopDaemon`. The stop holds the mutex for the
whole SIGTERM-and-poll, and what it is waiting for is this very process to exit — so a
close that blocks on the mutex makes every stop wait out `killTimeoutMs` and then SIGKILL
a daemon whose `onShutdown` never finished. A try-lock cannot deadlock.

A failed try-lock means someone else holds the mutex, and both possibilities are safe:

- **A stopper**, waiting for us. It binds nothing and it removes nothing until we are
  gone, so removing our own socket and our own record is uncontended.
- **A booter**. It found our socket closed, classified us `stale`, and claimed the state
  file for itself — so the record no longer names our pid, and the guard refuses to touch
  it.

The pid guard is what makes the cleanup safe with or without the lock; holding the lock
only narrows the window between reading the record and acting on it. Leaving a stale
record behind is worse than that residual race, which the next booter reaps anyway.

## Dependency

`pnpm-workspace.yaml` gains `'@sozai/lock': ^0.1.0` in the catalog. `@tejika/process` gains
`"@sozai/lock": "catalog:"` — a published `^` range, not `workspace:`, per sozai's rule for
downstream consumers. `@sozai/async` comes in transitively. `@sozai/*` is already listed in
`minimumReleaseAgeExclude`.

## Public API

`@tejika/process` is at 0.2.0.

| | |
|---|---|
| removed | `LockRecord` type; `bootGraceMs` on `RunDaemonOptions` and `getDaemonStatus` |
| added | `DaemonState` type; `lockPath` and `lockTimeoutMs` options; `StopResult.reason: 'busy'`; re-exported `TimeoutInterruption` |
| unchanged | `pidPath` everywhere; `DaemonStatus` shape; `DaemonAlreadyRunningError`; `--pid-path`; `spawnDaemon` |

`TimeoutInterruption` is re-exported because it can now escape `runDaemon`: a boot that
cannot take the mutex within `lockTimeoutMs` throws it, and callers need something to catch.
It stays distinct from `DaemonAlreadyRunningError` — "someone is booting or stopping and
will not let go" is not "someone is already serving".

Breaking, so a `major` changeset: 0.2.0 → 0.3.0 under changesets' 0.x rules.

## Testing

`lock.test.ts` mostly deletes. Its worker-thread contention harness tests a mutex that
sozai now owns and tests. It is replaced by `state.test.ts`: the `pid > 0` validator, the
corrupt-JSON-reads-as-null path, and the absence of torn reads under concurrent `rename`.

Kept and adapted:

- `daemon.test.ts` — "reclaims a stale lockfile", "reclaims a corrupt lockfile", "refuses a
  live socket held with no lockfile", "removes the socket and the lockfile", all retargeted
  at the state file.
- `status.test.ts` — every `bootGraceMs` case is dropped. Added: `ready: false` plus a live
  pid classifies as `booting` with no clock involved.
- `controller.test.ts` — the split-brain tests boot real concurrent daemons and are the
  strongest regression net for this change. Unchanged, and must stay green.

New, because the mutex makes things provable that previously were not:

- Two concurrent in-process `runDaemon` calls on one app: exactly one wins, the other throws
  `DaemonAlreadyRunningError`. Deterministic — the mutex serializes, so no flake.
- `stopDaemon` concurrent with `runDaemon`: no interleaving. The boot either precedes the
  stop or waits it out.
- A booter SIGKILLed between `writeDaemonState(ready: false)` and the bind: the next boot
  takes it immediately, with no grace period elapsing.

## Where exclusion is still not absolute

Both inherited from `@sozai/lock`, both documented upstream, both strictly better than what
tejika has today.

1. **The reap is guarded but not atomic.** The read and the `rmSync` are separate syscalls
   and POSIX offers no unlink-if-identity, so a rare interleaving can have one waiter unlink
   another's fresh lock. Sozai jitters before reaping to narrow the window. Tejika's current
   reap is guarded by inode alone, which as described above is not a guard at all on Linux.

2. **A pid recycled within one boot wedges the lock.** A booter SIGKILLed mid-section whose
   pid is then reused by a live process reads as `'alive'` forever, so the lock is never
   stale. Today's `bootGraceMs` unwedges that after ten seconds; after this change nothing
   does, short of a reboot or an `rm`.

   Accepted. It requires a SIGKILL *and* a same-boot pid collision, and its consequence is a
   wedged boot — loud, and fixed by deleting one file — rather than a split brain, which is
   silent and corrupts data. Sozai chose the availability failure over the exclusion failure
   deliberately.

## Follow-up (not in this change)

**Upstream: opt-in `maxHoldTime` on `FileLockOptions`.**

`liveness.ts` warns *"Do not add a `maxHoldTime` to 'fix' the wedge — it trades the safe
failure for the unsafe one"*, and for sozai's general case that is right: a critical section
can legitimately block for minutes on an OS keychain prompt, so a hold bound would hand a
second process the same section.

Tejika's boot section is roughly 100ms. For a caller that can prove its section is short, a
hold bound is safe and would close residual failure 2 above. Worth proposing upstream as an
opt-in option, off by default, with the safety argument stated at the call site. It is not a
blocker: taking a dependency on unreleased upstream work to fix a wedge this rare is a bad
trade.
