# Sakui: migrate to the new `@tejika/process` API, and delete the bespoke daemon code

**Priority:** backlog
**Origin:** the `process-daemon-robustness` branch (2026-07-09..11) landed both seams Sakui was blocked on (P1/P2, previously `backlog/2026-07-05-extend-process-daemon-serving-and-client.md`, now closed) *and* broke the API substantially. Sakui is the only known consumer, so its migration is the one that matters.
**Where:** Sakui's `apps/cli/src/daemon/host.ts` (serving loop) and `apps/cli/src/daemon/controller.ts` (`createDaemonClient` duplicate).
**When:** whenever Sakui next bumps `@tejika/process`. Not urgent — nothing forces the bump — but the two halves below should land together.

## Half 1 — the win: delete duplicated code

Both seams Sakui asked for now exist:

- **P1 — `runDaemon({ createTransport })`.** An optional per-connection transport factory, `(socket: Socket) => ServerTransportOf<Protocol>`, defaulting to today's `new SocketTransport({ socket })`. Sakui can build the transport from the raw socket, wrapping the readable in its channel-token-signing `mapAsync` — which is the whole reason it kept a bespoke `createServer`/listen/chmod/pidfile/shutdown loop. That loop can go; the signing logic stays in Sakui's factory.
- **P2 — `createDaemonTransport(opts)`.** Returns `{ transport, handleTransportDisposed, handleTransportError, dispose }`. Sakui passes the three hooks into its own `RuntimeClient` constructor and wires `dispose` to that client's teardown, deleting the ~60-line duplicated reconnect/backoff/dispose body from `controller.ts`.

The reconnect machinery Sakui inherits is also better than the copy it deletes: full-jitter backoff that resets only after a connection has stayed up for a 2000ms stability window (resetting on connect lets an accept-then-crash daemon churn at the base delay forever), and a connect timeout, which `@enkaku/socket`'s `connectSocket` still lacks.

## Half 2 — the cost: breaking changes to absorb

Full table in `packages/process/README.md` ("Breaking changes"). The ones that will actually bite Sakui:

| Before | After |
|---|---|
| `getPidPath` | **`getPIDPath`** — hard rename, no alias |
| `getDaemonStatus()` sync, returned `{ running, pid?, stale }`, reaped stale pidfiles as a side effect | **async** and **pure** (never reaps); returns a union discriminated on `state`: `'not-running' \| 'stale' \| 'booting' \| 'running' \| 'running-not-owned'`. **There is no `.running` boolean.** |
| `stopDaemon(): Promise<void>`, could throw | `Promise<StopResult>` (`{ stopped, pid?, reason? }`) — waits for exit, escalates to SIGKILL, reports failure rather than throwing |
| `runDaemon(): Promise<void>`, signal handlers always installed | `Promise<DaemonHandle>` (`{ pid, socketPath, pidPath, close() }`); signal handlers opt-in via `handleSignals` (default `true`) |
| `ensureDaemon({ timeoutMs })` bounded only the post-spawn connect retries | `timeoutMs` bounds the **whole call** (connect, spawn, socket wait, retries); default 5000 → 10000 |

**`'booting'` is the one to think about, not just mechanically port.** A daemon now claims its pidfile lock under `O_EXCL` *before* binding its socket — that ordering is what closes the split-brain boot race. So a lock record on disk is no longer proof of readiness. Anywhere Sakui used to read `.running === true`, the correct mapping is `state === 'running'` — **not** `state !== 'not-running'`. Accepting `'booting'` as running reintroduces exactly the race this work removed.

## The migration trap: old daemons go invisible

The pidfile changed from a bare PID integer to a JSON `LockRecord` (`{ pid, socketPath, startedAt, ready }`).

An old-format pidfile does not parse as a conforming `LockRecord`, so the new `getDaemonStatus` classifies it as **`'not-running'`** — meaning **a still-running old daemon is reported as absent**. The next boot attempt then tries to claim a lockfile that already exists and surfaces a confusing (if harmless) `DaemonAlreadyRunningError` instead of a clean takeover.

**Stop any running Sakui daemon before the upgrade lands.** Worth a line in Sakui's own release notes, not just this file — it will hit developers' machines, not just CI.

## Acceptance

- Sakui's bespoke serving loop in `host.ts` is gone, replaced by `runDaemon` + a signing `createTransport`.
- Sakui's duplicated reconnect body in `controller.ts` is gone, replaced by `createDaemonTransport` feeding `RuntimeClient`.
- Every old-API call site migrated; no `.running` access survives (grep for it — a stale one is invisible to a typecheck that only covers `src/`, which is how two of them survived four commits inside tejika itself).
- A daemon spawned by Sakui is correctly reported `'running'` (not `'booting'`) before Sakui issues its first request.
