# `@tejika/process` daemon robustness — complete

**Status:** complete
**Completed:** 2026-07-11
**Branch:** `feat/process-daemon-robustness`

## Goal

Close finding H3 — a split-brain daemon boot race — and the twelve smaller defects around it, all rooted in the same mistake: the pidfile was trusted as the source of truth about liveness, and a bare PID integer cannot bear that weight.

The original bug: `runDaemon` checked the pidfile, unlinked whatever socket file it found, bound, and only then wrote the pidfile. Two daemons booting concurrently both passed the guard; the second unlinked the first's **live** socket. The first was left running, holding resources, unreachable, and invisible to `stopDaemon`.

## The core design decision

**The pidfile became an exclusive claim, taken BEFORE the socket is bound.** `openSync(path, 'wx')` (`O_CREAT|O_EXCL`) is atomic; `EEXIST` means someone else holds it. The winner alone proceeds to touch the socket file; **losers unlink nothing**. One atomic primitive, zero dependencies.

Two alternatives were rejected and are worth recording, because they will look attractive again:

- **An OS-held lock (`flock`/`fcntl`)** is race-free by construction and released by the kernel on death, so no stale-reaping logic need exist at all. Rejected on portability: Node has no native `flock`, and `fs-ext` is a native addon — unfit for a clean ESM foundation library.
- **Making the socket bind itself the lock** (bind a temp path, then `link()` it into place) is the truest single source of truth, since the socket is what clients actually use. Rejected because breaking a *stale* socket then needs a second reaper lock with mtime-age heuristics, and `link()`-ing a bound socket inode is too subtle for a foundation library.

The claim-based approach also resolved the PID-recycling, `EPERM`, and `NaN`-PID findings as a side effect, because the record it requires is richer than an integer.

## What was built

- **`lock.ts`** — the `O_EXCL` claim. The pidfile is now a JSON `LockRecord` (`{ pid, socketPath, startedAt, ready }`). The claim is **atomic**: the record is written to a temp file and `link()`ed into place, so the lockfile is never visible in a zero-byte state. Stale-lock reaping is **inode-guarded** — the inode is captured at conflict-read time and re-verified before the unlink, so a racer's fresh claim can never be deleted.
- **`daemon.ts`** — `runDaemon` returns a `DaemonHandle` (`{ pid, socketPath, pidPath, close() }`). Claim → socket cleanup → bind → `markReady()`. Shutdown destroys tracked connections **before** awaiting `server.close()` (its callback never fires while a client is attached). Signal handlers are opt-in (`handleSignals`, default `true`). Carries the P1 seam.
- **`status.ts`** — `getDaemonStatus` is now **async and pure** (it never reaps). It returns a union discriminated on `state`: `not-running | stale | booting | running | running-not-owned`. `ESRCH` means dead; **`EPERM` means alive-but-not-ours and is never stale**. `stopDaemon` returns a `StopResult`, escalates SIGTERM → SIGKILL, and **never throws**.
- **`spawn.ts`** — `spawnDaemon` races the child's exit against the socket wait, so a boot crash surfaces a `DaemonBootError` (carrying `logPath`) immediately instead of burning the full timeout. It defaults `pidPath` from `app` and always passes `--pid-path` to the child.
- **`deadline.ts`** — a composable signal+timeout budget. `ensureDaemon({ timeoutMs })` bounds the **whole** call under one deadline.
- **`socket.ts`** — a tri-state probe. A `'dead'` verdict authorizes unlinking a socket file, so it fails **safe**: only positively-dead errnos count as dead; anything unrecognized does not.
- **`client.ts`** — `createDaemonTransport` (the P2 seam) with full-jitter reconnect backoff that resets only after a connection proves stable.
- Typed errors: `DaemonAlreadyRunningError`, `DaemonBootError`.

Both API seams that Sakui was blocked on (P1 server-side transport factory, P2 client-side transport seam) shipped. Migration is filed separately — see `docs/agents/plans/backlog/2026-07-09-sakui-tejika-api-migration.md`.

## Two invariants that must not be broken

These were each violated at least once during implementation and are the reason for several of the bugs found:

1. **Abort vs timeout.** A budget that runs out throws a timeout `Error`; a **caller's** `AbortSignal` propagates its original `AbortError` untouched. Never convert one into the other. The only sanctioned arbiter is the deadline's `timedOut()`, which reads the timeout signal's own `.aborted` — exact at the deadline tick. A millisecond `remaining()` comparison is **not** a valid arbiter; it flakes at the boundary. (`stopDaemon` is the single sanctioned exception: it never throws, and reports a caller abort as `reason: 'aborted'`.)
2. **`booting` is not `running`.** Because the lock is claimed *before* the socket is bound, a lock record on disk is **not proof of readiness**. Anywhere old code checked a `.running` boolean, the correct mapping is `state === 'running'` — never `state !== 'not-running'`. Accepting `booting` as running reintroduces the exact race this work removed.

## Where the design was improved during implementation

The design accepted a **residual race**: two processes could both classify a lockfile as stale and both reap it, transiently deleting the winner's fresh lockfile, with `markReady()` re-verification and a live-socket check containing the damage. It argued the worst case was a transiently rewritten lockfile, never two live daemons.

The implementation closed it harder than designed, because two mechanisms turned out to be cheap: **inode-guarded reaping** (a reaper re-verifies the exact file it read before unlinking, so it cannot delete a fresh claim) and the **atomic link-based claim** (no zero-byte window for a racer to misread). The residual race no longer exists as designed; the fallbacks remain as defence in depth.

## Verification

Both suites green: `@tejika/process` 107/107, `@tejika/test` 33/33 (and env 19, server 25, ui 9, cli 3).

The load-bearing coverage is **cross-process**: two real OS processes cold-starting the same daemon concurrently, in the **default** path configuration, both required to get a working client. In-process tests could not see the bugs that mattered — where the lock claim is atomic with respect to the event loop, a race that exists between OS processes simply does not occur.

## Lessons worth carrying forward

**Tests whose names outran their assertions were the dominant failure mode** — five separate instances, each green while the bug was live. A test measured a promise settling rather than the process exiting; a backoff test forced `random() => 1`, the single draw that hid a collapse to a 0ms busy loop; the flagship concurrency test covered only the configuration nobody uses; an abort test asserted `child.killed`, which is only ever set by `child.kill()` and never by an external signal. On this work, a green suite was the least reliable signal available; deliberately reintroducing a bug and watching a test catch it was the most reliable.

**A task-scoped review cannot see a bug that lives between two correct tasks.** The boot-crash detector and the claim-before-bind were each correct alone; together they broke `ensureDaemon` for concurrent callers, and thirteen per-task reviews passed over it. Only the whole-branch review found it.

## Related

- `docs/agents/plans/backlog/2026-07-09-sakui-tejika-api-migration.md` — Sakui's migration to the new API, and the old-format pidfile trap (a still-running old daemon reports as **absent**, because a bare-integer pidfile does not parse as a `LockRecord`).
- `docs/agents/plans/backlog/2026-07-11-process-daemon-deferred-cleanups.md` — deferred minor cleanups from the final review.
- Two upstream `@enkaku/socket` gaps found here — no connect timeout + leaked listeners, and a dispose that only `unref()`d and skipped function sources entirely — were **fixed upstream and shipped in `@enkaku/socket` 0.19.1** (Enkaku PR #50) before this branch merged. This branch then deleted both local mitigations: `connectWithTimeout` no longer races a timer against the connect (it only owns the ETIMEDOUT `code` that `ensureDaemon`'s retry classification needs, by aborting with a reason of its own), and `dispose()` no longer destroys the socket by hand — `SocketTransport.dispose` flushes and destroys it, for every source shape. The bounded connect also closed deferred cleanup #3: `ensureDaemon`'s stale-socket probe now spends the same budget as the rest of the call.
