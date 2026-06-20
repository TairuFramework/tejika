# Tejika Packages Extraction & Mokei Migration — Completed (partial)

**Status:** partial — all five `@tejika/*` packages built (Tasks 1-5);
Mokei migration (Task 6) deferred to Mokei's own work (see
`../next/2026-06-20-mokei-tejika-migration.md`).
**Date:** 2026-06-20
**Branch:** `feat/packages-extraction` (6 commits on base `9b9f958`)

## Goal

Build out the five `@tejika/*` packages by extracting and generalising the mature
implementations from Mokei (donor) + one Sakui source, replacing app-specific
constants with an `app: string` parameter resolved through `@tejika/env`, keeping
the Enkaku wiring intact.

## What was built (all green: build 5/5, 32 tests, lint clean; all at 0.1.0)

- **`@tejika/env`** — full local path/port/env resolution. `getDataDir`,
  `getStateDir`, `getSocketPath(app, name?)`, `getPidPath`, `getPort(app, opts?)`.
  Each resolver checks its `appEnvVar(app, KEY)` override first
  (`<APP>_DATA_DIR`, `_STATE_DIR`, `_SOCKET_PATH`, `_PID_PATH`, `_PORT`), else
  falls back via `env-paths` / `get-port`. 13 tests.
- **`@tejika/process`** — daemon lifecycle + reconnecting Enkaku client.
  `runDaemon` (split-brain guard, socket bind, `chmod 0o600`, pidfile,
  SIGINT/SIGTERM cleanup, per-connection `serve` callback), `spawnDaemon`
  (nano-spawn detached, log redirect, socket-readiness poll), `createDaemonClient`
  (reconnect backoff 250ms–5s, two-fence dispose), `ensureDaemon` (connect else
  spawn+retry, stale-socket reap), `getDaemonStatus`, `stopDaemon`. Generic over
  `Protocol`. Status unit test + a real spawn/reconnect integration test (boots a
  tsx-run daemon fixture, SIGKILLs it, asserts the original client reconnects).
- **`@tejika/server`** — local Hono HTTP server. `createLocalServer` (loopback
  default: 127.0.0.1 + random 256-bit token + Host/Origin/token gate; network:
  0.0.0.0 + CORS + custom auth hook), `buildAllowedHosts`, `verifyLoopbackRequest`,
  `attachEnkakuTransport`, `serveStaticSPA`. 6 tests incl. the accept/reject auth
  matrix.
- **`@tejika/cli`** — commander + Ink plumbing. `buildProgram`, `runInk`,
  `renderStatic`, `withSocketPath`/`withPort`/`withLogLevel` (defaults resolved
  lazily through `@tejika/env` at action time via preAction hooks). 2 tests incl.
  a subprocess `--version` integration test.
- **`@tejika/ui`** — generic Ink component kit: `StatusLine`, `Footer`,
  `KeyHints`, `ConfirmCard`, `SelectCard`, `Spinner`, `IconLine`, `SystemNotice`
  (each default + named export, props-only, stripped of all chat-domain coupling).
  9 tests.

## Key design decisions

- **`app: string` is the uniform generalisation seam** — every place a
  Mokei/Sakui constant baked in `~/.mokei`/`~/.sakui`, a socket path, pidfile, or
  log path now takes `app` and resolves through `@tejika/env`.
- **Depend on Enkaku directly** — `SocketTransport`/`Client`/`Server`/
  `ServerTransport` consumed straight, no transport-agnostic abstraction layer
  (YAGNI).
- **Security defenses preserved verbatim** in `@tejika/server`: Host allowlist
  (DNS-rebinding, incl. IPv6 `[::1]`), Origin allowlist (CSRF, with no-Origin
  passthrough for non-browser clients), timing-safe `crypto.timingSafeEqual`
  Bearer comparison with length guard, socket `chmod 0o600`. `injectToken`
  JSON-encodes + unicode-escapes `<`/`>` so a token can't break out of `<script>`.
- **`@enkaku/protocol` added to the catalog** (`^0.17.0`) for the generic
  protocol types used across `process`/`server`.
- **createDaemonClient returns `Promise<Client<Protocol>>`** (initial connect is
  async) — deviation from the original one-line sketch, intentional.

## Deviations from the original plan

- **`@tejika/cli` integration test uses a subprocess + tsx + `strip-ansi`**
  instead of `node-pty` — `node-pty` was not in the catalog and `--version` is
  non-interactive, so no pseudo-TTY is needed. `node-pty` was deliberately not
  added.
- **Packages set to `0.1.0`** (not `0.0.0`) so Mokei can depend on a real version.
- **Task 6 (Mokei migration) not performed here** — extracted to `next/`; Mokei
  will adopt `@tejika/*` in its own repo.

## Known follow-up nits (non-blocking; from per-task + final reviews)

- `getSocketPath(app, name)` bypasses the `SOCKET_PATH` env override when `name`
  is supplied (the one resolver not honouring the override first) — needs a JSDoc
  note. No current consumer passes `name`.
- Option-key naming: `waitForSocket {timeout, interval}` vs `ensureDaemon
  {timeoutMs, intervalMs}` within `@tejika/process` (cosmetic).
- `injectToken` (XSS-escaping) is internal-only — not exported, no direct unit
  test (covered indirectly).
- All packages' build tsconfig `include` is `./src/**/*`, so `test:types` does not
  type-check `test/` (Yulsi-stack convention).
- `@tejika/process` daemon `shutdown` calls `server.close()` without awaiting the
  connection drain (single-client design); `spawnDaemon` has no socket-timeout
  override option.
