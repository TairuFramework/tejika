# `@tejika/process` daemon robustness — design

**Date:** 2026-07-09
**Origin:** `docs/agents/plans/next/2026-07-06-process-daemon-robustness.md` (repo audit
2026-07-02, finding H3 plus all `@tejika/process` mediums and lows), folding in
`docs/agents/plans/backlog/2026-07-05-extend-process-daemon-serving-and-client.md` (P1 and P2).
**Scope:** all 16 audit findings, the two API seams, test backfill, and the two upstream
Enkaku filings.

## Problem

`@tejika/process` boots a daemon by checking a pidfile, unlinking whatever socket file it
finds, binding, and only then writing the pidfile. Two daemons booting concurrently both pass
the guard; the second unlinks the first's *live* socket, binds its own, and overwrites the
pidfile. The first daemon is orphaned: running, holding resources, unreachable, and invisible
to `stopDaemon`. That is finding H3, and it is the reason for this work.

Around it sit twelve smaller defects with a common root: the pidfile is trusted as the source
of truth about liveness, and it cannot bear that weight. A bare integer cannot distinguish a
live daemon from a recycled PID. `process.kill(pid, 0)` throwing `EPERM` means the process
exists and belongs to another user, but the current code reads any throw as "dead" and reaps
the file. Shutdown does not await `server.close()`, does not dispose live connections, and
turns an `onShutdown` rejection into an unhandled rejection. Timeouts do not compose. Nothing
accepts an `AbortSignal`.

## Non-goals

- Windows support. `getSocketPath` returns a filesystem path with no `\\.\pipe\` branch; this
  design assumes POSIX unix domain sockets throughout.
- Working around bugs in `@enkaku/*`. Two are identified below and filed upstream.
- P2's consumer-side adoption. Sakui's `RuntimeClient` rebuild happens in the Sakui repo.

## Approach: the pidfile becomes an exclusive claim

Any lock a process can leave behind when it crashes needs stale-reaping, and the reap step
reintroduces the race it was meant to close. Three ways out were considered.

**A — exclusive pidfile claim as the boot critical section.** `openSync(path, 'wx')` is atomic;
`EEXIST` means someone else holds the claim. The winner alone proceeds to touch the socket
file; losers never unlink anything. Zero dependencies.

**B — an OS-held lock (`flock`/`fcntl`).** Race-free by construction and released by the kernel
on death, so no stale logic exists at all. Rejected on portability: Node has no native `flock`,
`fs-ext` is a native addon (prebuilds, unfit for a clean ESM foundation library), and macOS does
not ship `flock(1)`.

**C — the socket bind is the lock.** Bind a unique temp path, then `link()` it into place —
atomic, `EEXIST` if taken. The truest single source of truth, since the socket is what clients
actually use. Rejected: breaking a stale socket needs a *second* reaper lock with mtime-age
heuristics, and `link()`-ing a bound socket inode is too subtle to leave in a foundation library.

**A is chosen.** One atomic primitive, no dependencies, and the record change it requires also
resolves the PID-recycling, `EPERM`, and `NaN`-pid findings. C's extra correctness only appears
in a crash-during-reap window that A already degrades safely (see *Residual race* below).

## Module layout

`daemon.ts` currently does claiming, binding, serving, shutdown, and spawning. It splits:

| File | Purpose |
|------|---------|
| `lock.ts` *(new)* | Record format, atomic claim, guarded reap, release |
| `status.ts` | Classify a record into a state; `stopDaemon` |
| `daemon.ts` | `runDaemon` — claim, bind, serve, shutdown handle |
| `spawn.ts` *(new, split out)* | `spawnDaemon` — child process, log, boot-crash race |
| `deadline.ts` *(new)* | Shared timeout budget and `AbortSignal` plumbing |
| `errors.ts` *(new)* | Typed errors with `code` |
| `socket.ts` | `probeSocket`, `waitForSocket`, `safeRemove` |
| `controller.ts` | `ensureDaemon` |
| `client.ts` | `createDaemonTransport`, `createDaemonClient` |

The module is named `lock.ts` rather than `pidfile.ts` because the semantic shift is the whole
point: the file stops being "where we wrote the pid" and becomes "the thing you must hold to
boot". The option name stays `pidPath`, matching the `.pid` file and the `TEJIKA_*_PID_PATH`
environment variable.

## The lock

```ts
type LockRecord = {
  pid: number
  socketPath: string
  startedAt: number
  /** False between claiming the lock and binding the socket. */
  ready: boolean
}

type DaemonLock = {
  record: LockRecord
  /** Rewrite the record with `ready: true`; re-verifies the file is still ours. */
  markReady(): void
  /** Unlink the lockfile, but only if it still holds our record. */
  release(): void
}

function claimDaemonLock(
  pidPath: string,
  record: LockRecord,
): DaemonLock | { conflict: LockRecord | null }
```

`claimDaemonLock` opens with `wx` (`O_CREAT | O_EXCL`) and writes the record as JSON. On
`EEXIST` it returns the conflicting record, or `{ conflict: null }` when the file is unreadable
or does not parse — a corrupt record is treated as stale, which is the `NaN`-pid finding.

`ready` is a two-phase marker. The claim is taken *before* the socket binds, so a concurrent
observer must be able to tell "booting" from "crashed after claiming". Without it, a daemon
mid-boot looks identical to a daemon that died between claim and bind.

## Status classification

`getDaemonStatus` becomes **async**, because deciding liveness requires probing the socket. It
also becomes **pure**: it no longer reaps the pidfile as a side effect. Reaping moves into the
claim path, where it is guarded. That change alone fixes the "`EPERM` reaps a live daemon's
pidfile" finding.

```ts
type DaemonStatus =
  | { state: 'not-running' }
  | { state: 'stale'; pid: number }
  | { state: 'booting' | 'running'; pid: number; socketPath: string }
  | { state: 'running-not-owned'; pid: number; socketPath: string }
```

Classification from a record:

| `kill(pid, 0)` | socket probe | record | → state |
|---|---|---|---|
| `ESRCH` | — | — | `stale` |
| `EPERM` | — | — | `running-not-owned` |
| ok | — | `ready: false`, younger than `bootGraceMs` | `booting` |
| ok | — | `ready: false`, older than `bootGraceMs` | `stale` |
| ok | live | `ready: true` | `running` |
| ok | dead | `ready: true` | `stale` |

Only `ESRCH` means dead. `EPERM` means a live daemon owned by another user: neither its pidfile
nor the process itself is touched.

The last row is the PID-recycling fix — a recycled PID is alive but its socket is not, so it no
longer wedges `runDaemon` forever. It carries one accepted consequence: a genuinely-alive daemon
whose socket file was unlinked out from under it is classified `stale` and reclaimed. Such a
daemon is already unreachable by every client, so reclaiming is the correct call. This warrants
a comment at the classification site.

`bootGraceMs` defaults to 10_000.

## Boot sequence

```
mkdir socket dir + pid dir, mode 0o700     ← closes the chmod-after-listen window
claim = claimDaemonLock(pidPath, { ready: false })
  └─ EEXIST → classify the conflicting record
       running | booting | running-not-owned → throw DaemonAlreadyRunningError
       stale → reap, then retry the claim (max 3 attempts, then throw)
we are the sole claimant:
  socket file exists?  live → release claim, throw DaemonAlreadyRunningError
                              (a foreign daemon holds it with no lockfile)
                       dead → safeRemove
server.listen(socketPath); chmod 0o600
claim.markReady()
return handle
```

The reap unlinks only if `statSync(pidPath).ino` still matches the inode we read the record
from. Losers never unlink a socket, and never unlink a lockfile whose record they have not
first classified as stale.

### Residual race

Two processes can both classify the same lockfile as stale and both reap it. Loser B may unlink
winner A's *fresh* lockfile in the window after A's claim succeeded. Two mechanisms contain this:

1. `markReady()` re-verifies the file and rewrites it when it is missing or holds a foreign
   record, so A recovers its own lockfile.
2. B's retried claim reaches the socket check, finds A's socket **live**, and refuses to unlink
   it — B throws `DaemonAlreadyRunningError`.

The worst case is therefore a transiently rewritten lockfile, never two live daemons. This is
the bounded degradation that makes approach C's extra machinery unnecessary.

## Shutdown

`runDaemon` returns a handle instead of `void`. Source-compatible: callers that ignore the
return value still typecheck.

```ts
type DaemonHandle = {
  pid: number
  socketPath: string
  pidPath: string
  close(): Promise<void>
}
```

`RunDaemonOptions` gains `handleSignals` (default `true`), `shutdownTimeoutMs` (default 5000),
`signal?: AbortSignal`, and `onError?: (err: unknown) => void`.

Signals stay on by default so no existing consumer silently stops handling `SIGTERM`. Tests pass
`handleSignals: false` and call `close()` — which is what makes the concurrent-boot test possible
in a single process.

`close()` is idempotent; repeat calls return the first promise. Ordering:

```
remove signal handlers
await server.close()                       ← stop accepting; today this is not awaited
dispose connection handlers, destroy tracked live sockets
await onShutdown(), bounded by shutdownTimeoutMs
finally: safeRemove(socketPath); lock.release()
```

Cleanup runs in a `finally`, so a rejected or timed-out `onShutdown` never leaves a socket or
lockfile behind. On the signal path such a failure is logged and the process exits `1`; on the
programmatic path `close()` rejects and the caller decides.

The connection handler tracks live sockets in a `Set` so shutdown can destroy them, and wraps
`opts.serve` in try/catch — a synchronous throw destroys that one connection instead of taking
the daemon down. After boot, `server.on('error')` routes to `onError` rather than to the boot
promise's already-settled `reject`.

## Timeout budget

New `deadline.ts`:

```ts
type Deadline = { remaining(): number; expired(): boolean; signal: AbortSignal }
function createDeadline(timeoutMs?: number, signal?: AbortSignal): Deadline
```

It composes the caller's signal with a timer via `AbortSignal.any`, and threads through
`waitForSocket`, `spawnDaemon`, `connectWithRetry`, and the initial connect.

`ensureDaemon({ timeoutMs })` now bounds the **whole** operation. Today `spawnDaemon` hardcodes a
3000ms socket wait and `timeoutMs` governs only `connectWithRetry`, so the two do not compose.
The default rises from 5000 to 10_000 to cover both phases without regressing boot on slow
machines.

`spawnDaemon` races the socket wait against the child's exit:

```ts
const exited = subprocess.then(
  (result) => { throw new DaemonBootError('daemon exited during boot', { logPath, result }) },
  (cause) => { throw new DaemonBootError('daemon failed to start', { logPath, cause }) },
)
try {
  await Promise.race([waitForSocket(socketPath, { deadline }), exited])
} finally {
  exited.catch(() => {})
}
```

A boot crash now surfaces the child's error and a pointer to `logPath` immediately, instead of
burning the full socket-wait timeout and reporting an opaque failure. The trailing `catch`
prevents an unhandled rejection once the race has settled, which is what today's blanket
`subprocess.catch(() => {})` was for.

`SpawnDaemonOptions` gains `env`, `pidPath`, `logPath`, `timeoutMs`, and `signal`. `env` also
serves the test-hygiene finding: tests stop mutating the parent process's `NODE_OPTIONS`.

The initial `connectSocket` gains a timeout by racing a timer and attaching
`.then((socket) => socket.destroy())` to the still-pending connect, so a wedged daemon cannot
hang `ensureDaemon` past `timeoutMs` and the eventual socket does not leak. This fully mitigates
the low within tejika, without touching Enkaku.

Typed errors in `errors.ts`, each carrying a `code`: `DaemonAlreadyRunningError` and
`DaemonBootError`. A failed stop is reported through `StopResult.reason`, not thrown.

## stopDaemon

```ts
type StopResult = {
  stopped: boolean
  pid?: number
  reason?: 'not-running' | 'not-owned' | 'timeout'
}

function stopDaemon(opts: {
  app: string
  pidPath?: string
  waitForExit?: boolean   // default true
  killTimeoutMs?: number  // default 5000
  signal?: AbortSignal
}): Promise<StopResult>
```

`SIGTERM`, then poll `kill(pid, 0)` until `ESRCH`; on timeout escalate to `SIGKILL` and poll
again. An `ESRCH` arriving between the status read and the kill means the process already exited
— that counts as `stopped`, not an error, which is the "races its own check" finding. `EPERM`
returns `not-owned` and touches nothing. The lockfile is removed only when its record's `pid`
matches the process just confirmed dead.

## socket.ts and client.ts

`probeSocket(path) → 'live' | 'dead' | 'forbidden'`. `EACCES` and `EPERM` mean *something is
listening* and stop counting as dead. Status consumes the tri-state; `isSocketLive` remains as a
boolean wrapper for callers that do not care.

Reconnect backoff gains full jitter — `Math.random() * Math.min(cap, base * 2 ** attempt)` — and
the backoff now resets only after a connection has stayed open for 2000ms, rather than on a raw
TCP connect. An accept-then-crash daemon backs off instead of churning at 250ms forever.

## API seams (folded in from the 2026-07-05 backlog item)

### P1 — server-side transport factory

```ts
createTransport?: (socket: Socket) => ServerTransportOf<Protocol>
```

Added to `RunDaemonOptions`, defaulting to `new SocketTransport({ socket })`. It slots into the
connection handler being rewritten above, so it inherits the socket tracking, the try/catch, and
shutdown disposal. Omitting it reproduces today's behaviour exactly. It lets a consumer wrap the
connection stream — Sakui signs channel tokens on the way in — without reimplementing the serving
loop.

### P2 — client-side transport seam

```ts
type DaemonTransport<Protocol extends ProtocolDefinition> = {
  transport: ClientTransportOf<Protocol>
  handleTransportDisposed: () => ClientTransportOf<Protocol> | undefined
  handleTransportError: () => ClientTransportOf<Protocol> | undefined
  /** Abort reconnection; wire to the domain client's dispose. */
  dispose: () => void
}

function createDaemonTransport<Protocol extends ProtocolDefinition>(
  opts: CreateDaemonClientOptions,
): Promise<DaemonTransport<Protocol>>
```

`createDaemonClient` becomes a thin wrapper: build the `DaemonTransport`, pass its three fields
into `new Client(...)`, wire `client.events.on('disposing', dispose)`. Its signature and
behaviour are unchanged.

The seam lands here rather than in its own cycle because the reconnect body is being rewritten
anyway (jitter, stable-connection reset, `signal`, `connectTimeoutMs`). Extracting it now means a
consumer's domain client — Sakui's `RuntimeClient`, which cannot nest inside an Enkaku `Client` —
gets the *hardened* reconnect rather than the old one. `CreateDaemonClientOptions` gains `signal`
and `connectTimeoutMs`, and both flow through the seam.

## Breaking changes

Minor bump on a `0.x` package. The changeset documents each.

| Before | After |
|---|---|
| `getDaemonStatus(): DaemonStatus`, sync, reaps the stale pidfile | `getDaemonStatus(): Promise<DaemonStatus>`, pure, never reaps |
| `DaemonStatus = { running; pid?; stale }` | discriminated union on `state` |
| `stopDaemon(): Promise<void>`, fire-and-forget `SIGTERM` | `Promise<StopResult>`, waits and escalates by default |
| `runDaemon(): Promise<void>` | `Promise<DaemonHandle>` (source-compatible) |
| `ensureDaemon({ timeoutMs })` bounds the connect only | bounds the whole call; default 5000 → 10_000 |
| `@tejika/env` `getPidPath` | `getPIDPath` — hard rename, no alias |

The `getPidPath` rename resolves a pre-existing violation of the repo's "no lowercase
abbreviations" guardrail (`ID` not `Id`). Note `pidPath` as a variable or option name is already
compliant, since a leading abbreviation in camelCase is all-lowercase.

Consumers absorb the change when they next bump. Sakui consumes `getDaemonStatus`, `stopDaemon`,
`spawnDaemon`, and `getPidPath`; all four move, but Sakui lives in its own repo and is out of
scope for this branch — a backlog item records the migration. Mokei's migration is still pending
(`docs/agents/plans/next/2026-06-20-mokei-tejika-migration.md`) and absorbs the new API for free.

In-repo, `@tejika/test`'s `waitForDaemonRunning` and `waitForDaemonStopped` call
`getDaemonStatus` and read `status.running`. Both move to `await` and the `state` union, and
`waitForDaemonRunning` must now wait for `state === 'running'` — treating `booting` as
not-yet-running. Its doc comment ("daemons write their pidfile only after their socket accepts
connections") becomes false under the new claim-before-bind order and is corrected.

The repo has no `.changeset/` directory — changesets arrive with the publishing-readiness item
(`docs/agents/plans/next/2026-07-06-publishing-readiness.md`). Until then the breaking changes
are recorded in a new `packages/process/README.md`.

## Testing

| File | Covers |
|------|--------|
| `lock.test.ts` | claim succeeds; `EEXIST` returns the conflict; corrupt record → `conflict: null`; reap unlinks only on an inode match; `markReady` rewrites a lockfile a racing reaper removed |
| `status.test.ts` | the classifier, with injected `kill` and `probe` — this is how `EPERM` and PID recycling are covered without needing a second user or a recycled PID |
| `daemon.test.ts` | two concurrent in-process `runDaemon` calls (`handleSignals: false`): exactly one wins, the loser throws `DaemonAlreadyRunningError`, the winner's socket stays live; shutdown ordering; `serve` throwing synchronously; `onShutdown` rejecting; `onShutdown` hanging past `shutdownTimeoutMs` |
| `spawn.test.ts` | a crash-on-boot fixture surfaces `DaemonBootError` with `logPath`, well before the socket-wait timeout |
| `controller.test.ts` | `ensureDaemon({ timeoutMs })` bounds the whole call, including a wedged daemon that accepts but never responds |
| `client.test.ts` | backoff jitter stays within bounds; backoff does not reset on a connection that closes before the stability window |

The classifier is exported for tests from `src/status.ts` directly, not from the package index —
tests already import from `../src/`.

Hygiene, per the audit: every test uses `mkdtempSync` for its paths and passes `pidPath`
explicitly, so nothing touches the real state directory. The existing `spawn.integration.test.ts`
stops mutating `NODE_OPTIONS` and passes `env` to `spawnDaemon` instead.

## Upstream (Enkaku)

Filed against the Enkaku repo, per the guardrail against working around `@enkaku/*` bugs:

1. `@enkaku/socket` `connectSocket` leaves both the `connect` and `error` listeners attached, and
   offers no connect timeout.
2. `SocketTransport.dispose` only unrefs its socket rather than destroying it.

Issue links are recorded in the implementation plan once filed. Neither blocks this work: the
connect timeout is mitigated locally as described above.

## Acceptance

- Two concurrent daemon boots: exactly one wins, the other exits with a clear error, and no live
  socket is unlinked.
- `EPERM` on `kill(pid, 0)` reports `running-not-owned` and does not reap the lockfile. Only
  `ESRCH` is stale.
- A recycled PID does not wedge `runDaemon`, and `stopDaemon` never signals an innocent process.
- A boot crash surfaces the child's error and `logPath` before the socket-wait timeout expires.
- `ensureDaemon({ timeoutMs })` bounds the whole operation, including a wedged daemon.
- `runDaemon` without `createTransport` behaves exactly as it does today.
- `createDaemonClient` keeps its current signature, implemented over `createDaemonTransport`.
- All tests above green; `pnpm test` and `pnpm lint` green.
- The two Enkaku issues are filed and linked in the plan.
