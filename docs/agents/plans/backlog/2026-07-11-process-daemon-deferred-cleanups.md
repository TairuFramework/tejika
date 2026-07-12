# `@tejika/process` — deferred cleanups from the daemon-robustness review

**Priority:** backlog
**Origin:** the final whole-branch review of the daemon-robustness work (2026-07-11) triaged these as defer-not-block. See `docs/agents/plans/completed/2026-07-11-process-daemon-robustness.complete.md` for what that work built and the invariants it established.
**Where:** `packages/process/src/{lock,status,controller}.ts`

None of these is a correctness bug today. Each is a small crack that the surrounding code currently papers over — worth closing the next time the relevant file is opened, not worth a branch of its own.

## 1. `DaemonLock.record` exposes a live mutable object

`lock.ts` — the getter hands back the held record itself, so a caller can mutate the lock's state in place. Internal-only today, and nothing does. A getter returning a copy (`{ ...held }`) is a one-line fix.

## 2. `checkLiveness` / `isGone` duplicate the errno → liveness mapping

`status.ts` — both map `EPERM` to "still there" and everything else to "gone". The polarity is consistent (checked during review), but the mapping exists twice because `stopDaemon` has no injected dependencies, unlike `classifyRecord`. Fold `isGone` into `checkLiveness` next time `status.ts` is touched.

Worth remembering **why** the mapping matters: `ESRCH` means the process is dead, but **`EPERM` means it is alive and owned by another user** — it must never be read as stale, because a stale verdict authorizes reaping the lockfile.

## 3. ~~`probeSocket` in `ensureDaemon` is not bounded by the deadline~~ — CLOSED

Closed on the same branch, once `@enkaku/socket` 0.19.1 gave `connectSocket` a `timeoutMs`/`signal`: `probeSocket` and `isSocketLive` now forward a `ConnectSocketOptions`, and `ensureDaemon` passes what is left of its budget. An abandoned probe rejects uncoded and so classifies as `unknown` — never `dead` — so a cancelled probe cannot authorise unlinking a live daemon's socket.

## 4. `spawnDaemon` never creates `dirname(pidPath)`

`spawn.ts` — it `mkdir`s the log and socket directories but not the state directory; only the child does. Harmless, because the parent only ever *reads* the pidfile and the read tolerates `ENOENT`. Noted for completeness; no fix needed unless the parent ever needs to write there.

## 5. Test-honesty debt

Two tests assert less than their titles promise. Neither is wrong, but neither would catch a regression on its own:

- The `stopDaemon` "unexpected errno becomes a result, never a rejection" test drives the internal helper directly, so `stopDaemon`'s own catch-all branch has no coverage. (Near-dead code — the helper can no longer throw — but the title implies more than it delivers.)
- The "returned client keeps an unclamped reconnect timeout" test asserts the *options passed to* the client, not the client's actual reconnect behavior. It is only honest because a sibling test in `client.test.ts` drives the real reconnect path; neither alone is sufficient.

This category is worth attention because tests whose names outran their assertions were the dominant failure mode of the daemon-robustness work — five instances, each green while a real bug was live.
