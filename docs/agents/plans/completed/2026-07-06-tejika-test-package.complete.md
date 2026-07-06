# @tejika/test — integration-test harness package

**Status:** complete
**Date:** 2026-07-06
**Branch:** `feat/test-package` (13 commits; merge-base `9ef57d1`, head `8d44fe1`)

## Goal

New sixth package `@tejika/test` (`packages/test`, 0.1.0): generic primitives
for integration-testing CLIs built on the `@tejika/*` stack. Extracted from the
hand-rolled harnesses in Mokei and Sakui (node-pty TUI driver, non-interactive
CLI runner, disposable env-override profile, daemon waits, a poll primitive,
vitest globalSetup helpers), consolidated into one reusable package and
dogfooded inside tejika before those consumers migrate.

## What was built

Seven modules under `packages/test/src/`, all re-exported from `index.ts`:

- `poll(fn, {timeoutMs, intervalMs})` — shared truthy-poll primitive
  (defaults 15_000 / 100). Every other wait helper builds on it.
- `runCLI(args, options)` (`run.ts`) — non-interactive command runner that
  **never rejects**: spawn failures (ENOENT) resolve with the message in
  `stderr` and `code: null` instead of hanging to the test timeout.
- `PTYDriver` (`pty.ts`) — node-pty real-TTY driver, a sync `Disposable`.
  Buffered ANSI-stripped `screen()`, windowed reads
  (`mark`/`screenSince`/`screenAfterLast`), `waitFor*` polling, key writers,
  `type()` at human speed. ES-private state (`#pty`/`#buf`/`#exit`); consumers
  subclass it for app-specific flows using only public methods.
- `createTestProfile(app, options)` (`profile.ts`) — throwaway temp dir with
  `<APP>_<KEY>` env overrides (via `@tejika/env`'s `appEnvVar`) pointing at it;
  an `AsyncDisposable` whose `onDispose` hook (daemon teardown) runs before the
  dir is removed. pid + monotonic counter isolate concurrent/repeated profiles.
- `waitForDaemonRunning` / `waitForDaemonStopped` (`daemon.ts`) — pidfile polls
  on `@tejika/process`'s `getDaemonStatus` (defaults 5_000 / 100).
- `assertBuilt(packages, from)` / `rebuild(dir, script)` (`setup.ts`) — vitest
  globalSetup helpers for tests that spawn built binaries.

Two dogfood integration tests prove the API from a consumer's seat:
- `packages/test` — daemon lifecycle against a **real detached daemon**
  (`createTestProfile` + `waitFor*` + `runDaemon`/`stopDaemon`).
- `packages/cli` — `runInk` under a **real PTY** via `PTYDriver`: the first
  TTY-path coverage of `runInk` (Ink's `setRawMode` throws without a real TTY).

Docs updated: package `README.md`, `AGENTS.md` package table, and
`docs/agents/architecture.md` (packages list + dependency graph).

## Key design decisions (rationale preserved from the spec)

- **Class core, free functions elsewhere.** `PTYDriver` is the one class
  (consumers subclass or wrap it); everything else is free functions. State is
  ES-private so subclasses compose via public methods with no protected surface.
- **`createTestProfile` is synchronous** (returns `TestProfile`, not a
  `Promise`) — a deliberate deviation from the original spec, which typed it
  async. The body does only sync fs work; the disposable is still
  `AsyncDisposable` so `await using` runs the async `onDispose`.
- **Error philosophy is deliberately mixed and documented.** Poll-family and
  `runCLI` return sentinels (`undefined`/`false`/`null`, never throw);
  `waitForDaemonRunning` **throws** on timeout (an assertion that never sees the
  daemon must fail loudly) while `waitForDaemonStopped` **returns** on timeout
  (teardown tolerates a stuck daemon). This asymmetry is intentional.
- **The `@tejika/process` dogfood test lives in `packages/test`, not
  `packages/process`** — a test in `packages/process` consuming `@tejika/test`
  (which depends on `@tejika/process`) would create a workspace dependency
  cycle. Keeping it in `packages/test` avoids that.
- **Two globalSetup mechanisms, split by ownership.** `assertBuilt` guards
  dependencies the package does not build (env/process, refreshed by turbo);
  `rebuild` refreshes the package-under-test's own `lib/` (cli). Principled, but
  it couples a package's whole test run to a prior build (see follow-ups).
- **Control bytes are `\u` string escapes**, never literal bytes in source
  (ESC = `\u001b`, ETX = `\u0003`) — literals are invisible and corrupt on copy.

## Verification

Full repo suite green: `@tejika/test` 27/27 across 7 files, `@tejika/cli` 3/3
(incl. the PTY test), whole repo 66/66 across 6 packages; native Biome clean.
Every task passed a per-task spec+quality review; the whole branch passed a
final cross-cutting review (verdict: ready to merge, zero Critical/Important).

## Deferred (minor, non-blocking)

Package-internal polish, safe to pick up anytime:
- `pty.ts` — `stripAnsi(...).replace(/\r/g,'')` is duplicated in `screen()` and
  `screenSince()`; factor a private `#clean` helper.
- `pty.ts` — the trivial key writers (`esc`/`tab`/`up`/`left`/`right`) and the
  `command`/`cols`/`rows`/`name` options have no direct test coverage.

Two CI/tooling follow-ups surfaced by this work were folded into
`docs/agents/plans/next/2026-07-06-ci-and-tooling-integrity.md` (node-pty
prebuilt exec-bit hazard; fresh-clone build-order for the test globalSetup).
That plan's existing "pre-commit re-stages fixes" finding was confirmed live
here: the Biome `organizeImports` autofix to `index.ts` was applied by the
pre-commit hook but left unstaged, so the first commit shipped an unsorted file
that native Biome rejected — a follow-up commit fixed it. `rtk lint biome`
reported that file clean, so it is not a trustworthy lint gate (native
`biome check` / the pre-commit hook are).

## Follow-ups elsewhere (unchanged)

Mokei and Sakui migrations to `@tejika/test` remain their own repos' work,
tracked by `docs/agents/plans/next/2026-06-20-mokei-tejika-migration.md`.
