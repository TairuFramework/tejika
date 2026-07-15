# `@sozai/lock` Daemon Locking Migration

**Status:** complete
**Date:** 2026-07-15
**Affects:** `@tejika/process`, `@tejika/env` (0.2.0 → 0.3.0; `server`/`cli`/`test` follow, `ui` stays 0.2.0)
**Branch:** `feat/sozai-lock` (18 commits, `2fa4b9f..2fae8f5`)

## Goal

Replace `@tejika/process`'s hand-rolled daemon lockfile with a short-lived `@sozai/lock`
mutex around the boot, stop, and close critical sections, moving daemon presence into a
separate state file.

## Why

The old `packages/process/src/lock.ts` was not a mutex — it was a daemon *presence record*
doubling as one: it carried application payload (`socketPath`, `ready`), was held for the
daemon's entire lifetime, was read by observers who never meant to acquire it
(`getDaemonStatus`), and a loser never waited (it threw `DaemonAlreadyRunningError`). With
no real mutex, every boot and stop was a check-then-act against the filesystem, guarded by
the subtlest code in the repo — and that code carried a real bug:

> `reapLockFile` guarded the unlink on the **inode alone**. The kernel recycles an inode
> number the moment a file is unlinked, so the lock claimed right after a stale one is
> reaped can land on the very inode the reaper still holds as its "stale" identity — and
> the reaper then unlinks a *live* daemon's fresh lock. An inode-only guard is not a guard.

`@sozai/lock` was extracted from this code and fixed exactly that, with a per-claim `nonce`
the inode cannot fake plus an OS boot ID (a pid is trusted only when it comes from this
boot).

## Key design decisions

- **Mutex vs. presence, split apart.** `@sozai/lock` is a short-lived mutex at
  `${pidPath}.lock`; presence lives at `pidPath` as a JSON `DaemonState`
  (`{ pid, socketPath, startedAt, ready }`) that tejika reads/writes itself (`state.ts`).
  Sozai keeps its axiom — *never key material, never caller payload*. The socket probe
  stays tejika's liveness proof; no mutex should know about sockets. Two upstream-churning
  alternatives (a payload lock, and a hybrid with two competing staleness authorities) were
  rejected. **No changes to `@sozai/lock` were required.**

- **Lock path derived, never configured.** `getLockPath(app) = ${getPIDPath(app)}.lock`,
  and internally `lockPath` defaults to `${pidPath}.lock`. No new env var, no new CLI flag —
  a second override could resolve differently in a spawned child than its parent, the exact
  split brain the mutex exists to prevent.

- **`bootGraceMs` deleted; the mutex decides `booting` by proof.** A `ready: false` record
  is only ever written *inside* the boot critical section, by a process holding the mutex.
  A booter that holds the mutex and reads such a record knows its writer does *not* hold the
  mutex — therefore that record is abandoned, and free to take. That is a proof, replacing a
  ten-second clock guess that failed in both directions (too short → steals the socket from
  a slow booter = split brain; too long → blocks a legitimate boot behind a corpse).
  `booting` survives only as an *observer* state (`ready: false` + live pid) for `spawn.ts`'s
  loser-concedes check.

- **Close retakes the mutex with a try-lock (`timeout: 0`), never a waiting acquire.** A
  *waiting* acquire deadlocks against `stopDaemon`: the stop holds the mutex through its
  whole SIGTERM-and-poll while waiting for that very process to exit, so a close that blocks
  on the mutex makes every stop burn `killTimeoutMs` and then SIGKILL a daemon whose
  `onShutdown` never finished. A failed try-lock falls through to a removal guarded by
  **both** the pid **and** a per-boot `Symbol` owner token — the pid alone cannot tell "my
  record" from "another boot in this same process".

- **Every state-file removal is unconditional, because every removal is under the mutex** (or
  behind the pid+owner guard when the try-lock could not be taken). This deleted the `link()`
  claim, the inode-guarded reaps, the temp-record sweep, the three-attempt retry loop, and
  `stopDaemon`'s captured-inode `reap` closure — all of which existed only to survive
  check-then-act. Atomic writes (temp `<path>.tmp` + `rename`) stay, because `getDaemonStatus`
  is a lock-free reader that must never see a torn file; the temp name is now fixed rather
  than random since only a mutex holder ever writes.

- **`pid > 0` security guard preserved verbatim.** A non-positive pid is not a daemon, it is
  a weapon: `process.kill(0, sig)` signals the whole process group (the CLI included) and
  `kill(-1, sig)` every process the user may signal, and both pass a `kill(pid, 0)` liveness
  check. `DaemonAlreadyRunningError.pid` also became optional (it had been carrying `-1`).

## What was built

`state.ts` (new: `DaemonState` + read/write/remove), `stop.ts` (new: `stopDaemon` under the
mutex, `reason: 'busy'` for a contended acquire), `status.ts` (shrunk to a pure, clock-free
`classifyState`/`getDaemonStatus`), boot + close in `daemon.ts` rewritten around the mutex,
`spawn.ts`/`controller.ts` call sites updated, `lock.ts` **deleted**. New tests pin the
`@sozai/lock` semantics depended on, torn-read freedom, the cross-process mutex property,
and the deadlock regression (~300ms against a 3000ms bound; a blocking shutdown acquire
would land at 5–7s). Repo green: `turbo run test` 9/9 tasks, 264 tests.

## Bugs the reviews caught (fixed on-branch)

- **CRITICAL — a regression the design itself introduced.** Deleting `bootGraceMs` was right
  for the boot path (which reclaims a `booting` record) but silently wrong for the stop path.
  `stopLocked` let `booting` fall through to SIGTERM → SIGKILL — but it *holds the mutex*, so
  a `ready: false` record it reads is abandoned by construction, and its live pid is a
  **recycled stranger**, not a daemon. The state file lives in `~/.config` and survives
  reboots, so `myapp stop` before `myapp start` could SIGKILL an unrelated process. Now
  `booting` is treated exactly like `stale`: remove the record, report `not-running`, signal
  nothing. Only `running` (live pid whose socket probes live) is ever signalled.
- **IMPORTANT — `ensureDaemon` still had a mutex-less check-then-act** unlinking a
  `dead`-probing socket, which could unlink a live daemon's fresh socket. Deleted; `runDaemon`
  does the identical reap under the mutex.
- **The owner-token window.** First cut published the token *after* the bind, leaving the
  claim→bind window open. Moved to publish *with* the claim, synchronously after
  `writeDaemonState`. Mutation-checked (reverting reproduces an uncaught `ENOENT` from `chmod`).

## Accepted residual risks (documented, not blockers)

Both inherited from `@sozai/lock`, both strictly better than what tejika had:

1. **The reap is guarded but not atomic** — POSIX has no unlink-if-identity, so a rare
   interleaving can have one waiter unlink another's fresh lock. Sozai jitters before reaping
   to narrow the window.
2. **A pid recycled within one boot wedges the lock** — a booter SIGKILLed mid-section whose
   pid is immediately reused reads as `'alive'` forever. Deliberate: the consequence is a
   wedged boot (loud, fixed by deleting one file) rather than a silent split brain. Sozai
   chose the availability failure over the exclusion failure on purpose.

Also documented on-branch: the boot holds the mutex across an unbounded socket probe (a
bound, not a bug); no test produces `reason: 'busy'` from genuine cross-process contention;
the owner-token invariant depends on `writeDaemonState` staying synchronous.

## Follow-on

Propose an opt-in `maxHoldTime` on `FileLockOptions` upstream in `@sozai/lock` — see
`docs/agents/plans/backlog/2026-07-15-sozai-lock-max-hold-time.md`.
