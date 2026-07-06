# Fix `@tejika/process` boot race, PID handling, shutdown, and timeout composition

**Priority:** next (step 5 of the 2026-07-02 audit's order of attack)
**Origin:** repo audit 2026-07-02 (finding H3 + all `@tejika/process` mediums/lows).
**Where:** `packages/process/src/daemon.ts`, `packages/process/src/status.ts`, `packages/process/src/controller.ts`, `packages/process/test/`.

Related backlog item: `2026-07-05-extend-process-daemon-serving-and-client.md`
(additive API seams for consumers) — coordinate if both touch `daemon.ts`
at the same time.

## High severity

### H3 — Split-brain TOCTOU race at daemon boot

`packages/process/src/daemon.ts:51-78` — the pidfile guard (`getDaemonStatus`)
is checked at L51 but the pidfile is only written at L78, after socket bind.
Two daemons booting concurrently both pass the guard; the second one hits
`existsSync(socketPath)` and `safeRemove`s the **live** socket of the first,
binds its own, and both write the pidfile (last writer wins). The first daemon
is orphaned: running, holding resources, unreachable, untracked by
`stopDaemon`.

**Fix:** take an exclusive claim before cleanup/bind — e.g.
`openSync(pidPath, 'wx')` (O_EXCL) as the lock — and check `isSocketLive`
before removing an existing socket file instead of trusting the pidfile alone.

## Medium severity

- `src/status.ts:14-16` — PID recycling: `process.kill(pid, 0)` reports a
  recycled PID as running; `runDaemon` then refuses to boot forever and
  `stopDaemon` SIGTERMs an innocent process. Cross-check `isSocketLive` and/or
  record start-time/argv in the pidfile.
- `src/status.ts:17-19` — any `process.kill` error is treated as "dead" and the
  pidfile deleted; `EPERM` means the process exists (owned by another user) —
  a live daemon's pidfile gets reaped. Only treat `ESRCH` as stale.
- `src/daemon.ts:80-88` — shutdown: `server.close()` not awaited, live
  connections not disposed before `process.exit(0)`; an `opts.onShutdown`
  rejection becomes an unhandled rejection; a hanging `onShutdown` blocks exit
  forever. Wrap in try/finally, await close, add a shutdown timeout.
- `src/daemon.ts:124-132` — `subprocess.catch(() => {})` swallows boot crashes;
  the caller burns the full `waitForSocket` timeout and gets an opaque error.
  Race `waitForSocket` against the subprocess result and surface the child's
  exit error with a pointer to `logPath`.
- `src/daemon.ts:132` + `src/controller.ts:16-17` — timeouts don't compose:
  `spawnDaemon` hardcodes the 3000ms socket wait; `EnsureDaemonOptions.timeoutMs`
  only governs `connectWithRetry`. Thread the budget through.
- `src/status.ts:23-26` — `stopDaemon` races its own check (`ESRCH` possible
  between status and kill), never waits for exit, no SIGKILL escalation.
  Tolerate `ESRCH`; add opt-in `waitForExit`/`killTimeoutMs`.
- `src/daemon.ts:42-89` — `runDaemon` has no programmatic stop: global signal
  handlers + `process.exit`, returns `void`. Return a handle
  (`{ close(): Promise<void> }`) and/or accept an `AbortSignal`.
- No `AbortSignal` anywhere in the public options (`ensureDaemon`,
  `createDaemonClient`, `waitForSocket`).

## Low severity

- No jitter in reconnect backoff; backoff resets on raw TCP connect
  (accept-then-crash loop churns at 250ms forever).
- Initial `connectSocket` has no timeout (wedged daemon hangs `ensureDaemon`
  past any `timeoutMs`) — mitigate here as far as possible without touching
  Enkaku (see upstream note below).
- `isSocketLive` treats `EACCES`/`EPERM` as dead.
- Corrupt pidfile leaks `pid: NaN`.
- `opts.serve` throwing synchronously takes the daemon down on one bad
  connection.
- `server.on('error', reject)` swallows post-boot errors.
- chmod-after-listen window (bind inside a `0o700` dir instead).
- `EnsureDaemonOptions` lacks `logPath`/`pidPath` passthrough.
- Test hygiene: mutating `NODE_OPTIONS`, default pid path touching the real
  state dir.

## Upstream (Enkaku — file there, not fixed here)

Per the guardrail "fix `@enkaku/*` bugs at the source repo", these audit
findings are to be filed against Enkaku, not worked around in tejika:

- `@enkaku/socket` `connectSocket` leaves both `connect`/`error` listeners
  attached and has no connect timeout.
- `SocketTransport` dispose only unrefs the socket rather than destroying it.

## Test backfill (part of acceptance)

Current tests cover the happy path (plus the SIGKILL/revive integration test);
none cover the risk surface. Add: concurrent-boot race (two `runDaemon` calls),
stale/recycled/corrupt pidfile handling, `EPERM` status, shutdown ordering,
boot-crash surfacing.

## Acceptance

- Two concurrent daemon boots: exactly one wins, the other exits with a clear
  error, no live socket is unlinked.
- `EPERM` on `kill(pid, 0)` reports "running (not owned)" and does not reap
  the pidfile; only `ESRCH` is stale.
- Boot crash surfaces the child's error + `logPath` before the socket-wait
  timeout expires.
- `ensureDaemon({ timeoutMs })` bounds the whole operation.
- New tests above green; `pnpm test` and `pnpm lint` green.
- Enkaku upstream items filed in the Enkaku repo (link the issues/plans here).
