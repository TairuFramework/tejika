# `@tejika/test` — integration-test harness package

**Date:** 2026-07-06
**Status:** approved design, pre-implementation

## Purpose

New sixth package `@tejika/test` (`packages/test`): generic primitives for
integration-testing CLIs built on the `@tejika/*` stack. Extracted from the
harnesses Mokei (`mokei/integration-tests/support/chat-driver.ts`) and Sakui
(`sakui/apps/cli/test/integration/support/{cli-harness,tui-driver,mcp-harness}.ts`)
each hand-rolled: a node-pty TUI driver, a non-interactive CLI runner, a
disposable env-override profile, daemon wait helpers, a poll primitive, and
vitest globalSetup helpers.

App-specific material stays in consumers: UI string tables, flow methods
(`addFetchContext`, `seedTasks`, `isIdle`), Sakui's MCP harness.

## Decisions (from brainstorming)

- **Scope:** everything — PTY driver, `runCLI`, profile, poll, daemon waits,
  setup helpers.
- **Name:** `@tejika/test`.
- **Extension model:** approach A — class core, subclass-or-wrap. `PTYDriver`
  is a class consumers subclass (`class ChatDriver extends PTYDriver`) or
  wrap; everything else is free functions.
- **Dogfood in this work:** `@tejika/cli` and `@tejika/process` gain
  integration tests consuming `@tejika/test`. Mokei/Sakui migrations are
  follow-ups in their own repos.

## Package layout

```
packages/test/
  src/
    index.ts      # re-exports
    pty.ts        # PTYDriver
    run.ts        # runCLI
    profile.ts    # createTestProfile
    daemon.ts     # waitForDaemonRunning / waitForDaemonStopped
    poll.ts       # poll
    setup.ts      # assertBuilt / rebuild
  test/
```

Standard kigu package scaffold (same scripts/tsconfig/swc setup as siblings).

## API

### `pty.ts` — `PTYDriver`

```ts
export type PTYDriverOptions = {
  command?: string            // default 'node'
  args: Array<string>
  cwd?: string
  env?: Record<string, string>
  cols?: number               // default 100
  rows?: number               // default 30
  name?: string               // default 'xterm-color'
}
export type PTYExit = { exitCode: number; signal?: number }

export class PTYDriver implements Disposable {
  constructor(options: PTYDriverOptions)

  // screen access
  screen(): string                          // full buffer, ANSI-stripped, \r removed
  mark(): number                            // buffer offset for windowed reads
  screenSince(since: number): string
  screenAfterLast(marker: string): string

  // waiting (poll-based, default interval 100ms)
  waitFor(text: string, timeoutMs?: number): Promise<boolean>
  waitForSince(text: string, since: number, timeoutMs?: number): Promise<boolean>
  waitForAfterLast(marker: string, text: string, timeoutMs?: number): Promise<boolean>
  waitForExit(timeoutMs?: number): Promise<PTYExit | null>

  // input
  write(data: string): void
  type(text: string, cps?: number): Promise<void>   // human-speed pacing, default 50 cps
  enter(): void; esc(): void; tab(): void
  up(): void; down(): void; left(): void; right(): void
  ctrlC(): void                             // single ^C; process stays alive

  kill(): void                              // ^C + pty.kill, tolerant of already-exited
  [Symbol.dispose](): void                  // = kill()
}
```

Notes:
- Union of Mokei's `ChatDriver` core and Sakui's `TUIDriver` (windowed reads
  from Sakui, `type(cps)` from Mokei). Nothing app-specific.
- `#pty`/`#buf`/`#exit` are ES-private; all behavior via public methods, so
  subclasses build flows from `write`/`screen`/`waitFor*` without protected
  state.
- `waitFor*` return `boolean` rather than throwing — matches existing suite
  style `expect(await d.waitFor(...)).toBe(true)`.
- Mokei's `isIdle` last-marker logic is expressible with
  `screen().lastIndexOf(...)`; stays in Mokei.
- Default timeouts: `waitFor*` 15_000ms, `waitForExit` 8_000ms (the values
  both repos converged on).

### `run.ts` — `runCLI`

```ts
export type RunCLIOptions = {
  command?: string                  // default 'node'
  env?: Record<string, string | undefined>
  cwd?: string
  input?: string                    // optional stdin, closed after write
  signal?: AbortSignal
}
export type CLIResult = { stdout: string; stderr: string; code: number | null }

export function runCLI(args: Array<string>, options?: RunCLIOptions): Promise<CLIResult>
```

Never rejects: a spawn failure (e.g. ENOENT) resolves immediately with the
error message appended to `stderr` and `code: null`, instead of hanging until
the test timeout (Sakui's pattern).

### `profile.ts` — `createTestProfile`

```ts
export type TestProfile = { dir: string; env: Record<string, string> } & AsyncDisposable
export type TestProfileOptions = {
  keys?: Array<string>              // env keys pointed at dir; default ['DATA_DIR', 'STATE_DIR']
  extraEnv?: Record<string, string>
  onDispose?: (profile: { dir: string; env: Record<string, string> }) => Promise<void> | void
}
export function createTestProfile(app: string, options?: TestProfileOptions): Promise<TestProfile>
```

- Temp dir `join(tmpdir(), `${app}-it-${process.pid}-${counter++}`)`;
  pre-clean (`rmSync` force) then `mkdirSync`. Monotonic counter prevents
  same-worker collisions; pid prevents cross-worker collisions.
- `env` = `{ ...process.env, [appEnvVar(app, key)]: dir for each key, ...extraEnv }`,
  built with `@tejika/env`'s `appEnvVar` so it tracks the resolver convention.
- Dispose order: `onDispose` hook first (consumer stops its daemon there),
  then `rmSync(dir, { recursive: true, force: true })`.

### `daemon.ts` — daemon waits

```ts
export type WaitForDaemonOptions = { pidPath: string; timeoutMs?: number; intervalMs?: number }
export function waitForDaemonRunning(options: WaitForDaemonOptions): Promise<number>  // resolves pid; throws on timeout
export function waitForDaemonStopped(options: WaitForDaemonOptions): Promise<void>   // returns on timeout (teardown semantics)
```

- Built on `@tejika/process` `getDaemonStatus`, not string-matching CLI
  output (Sakui's current approach).
- `pidPath` is explicit: a profile's env overrides are not visible to the
  test process's own `@tejika/env` resolvers, so the caller derives the path
  from `profile.dir`.
- Asymmetry is deliberate (Sakui's reasoning): an assertion that never sees
  the daemon running must fail loudly; teardown tolerates a stuck daemon.
- Defaults: `timeoutMs` 5_000, `intervalMs` 100.

### `poll.ts` — `poll`

```ts
export function poll<T>(
  fn: () => T | Promise<T>,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<T | undefined>
```

Resolves with the first truthy result of `fn`, or `undefined` on timeout.
The primitive `waitFor*`/daemon waits are built on; exported for consumers'
own conditions (replaces the ~8 hand-rolled deadline loops across Mokei and
Sakui). Defaults: `timeoutMs` 15_000, `intervalMs` 100.

### `setup.ts` — globalSetup helpers

```ts
export function assertBuilt(packages: Array<string>, from?: string): void
export function rebuild(dir: string, script?: string): void
```

- `assertBuilt`: `require.resolve` each package (via `createRequire(from ?? cwd)`);
  throw one error listing every missing package with "run `pnpm build` first".
- `rebuild`: `execSync('pnpm run <script ?? build:js>', { cwd: dir, stdio: 'inherit' })`
  — fast swc rebuild of the binary under test.

## Dependencies

- Regular: `node-pty` (native module), `strip-ansi`, `@tejika/env`
  (`workspace:^`), `@tejika/process` (`workspace:^`).
- Consumers install `@tejika/test` as a devDependency.
- Catalog entries for `node-pty` / `strip-ansi` in `pnpm-workspace.yaml`.

## Error handling summary

- `runCLI`: never rejects; spawn errors land in the result.
- `PTYDriver.kill`/dispose: swallow already-exited errors.
- `waitFor*`: return `false`/`undefined`/`null` on timeout (assert in tests);
  exception: `waitForDaemonRunning` throws (loud assertion).
- `createTestProfile` dispose: `onDispose` failures propagate (a broken
  teardown should fail the test), dir removal is `force: true`.

## Testing

In `packages/test/test/`:

- `poll`: truthy resolution, timeout → `undefined`, async fn, interval respected.
- `runCLI`: `node -e` fixtures for stdout/stderr/exit code; ENOENT command →
  `code: null` + message in stderr; `input` piped to stdin.
- `profile`: env keys built via `appEnvVar`, extra keys, dispose order
  (`onDispose` before dir removal — observable via hook reading the dir),
  counter isolation of two profiles.
- `daemon`: fixture pidfile + live/stale process → running resolves pid,
  stopped returns after kill; running throws on timeout.
- `PTYDriver`: integration test against a small plain-node fixture script
  (raw stdin, ANSI output — no `@tejika/cli` dependency, which would create a
  dev-dep cycle with the cli dogfood test) covering `waitFor`, `type`,
  windowed `mark`/`screenSince`, key writers, `waitForExit`, dispose. Real
  Ink-under-PTY coverage comes from the `@tejika/cli` dogfood test below.

## Dogfooding (in scope)

- `@tejika/cli`: PTY integration test of an Ink fixture through the real
  binary path (exercises `runInk` under a TTY — currently untested).
- `@tejika/process`: daemon lifecycle integration test using
  `createTestProfile` + `runCLI` + daemon waits (spawn/status/stop cycle).

These prove the API from a consumer's seat before Mokei/Sakui migrate.

## Out of scope / follow-ups

- Mokei and Sakui migrations to `@tejika/test` (their repos; file follow-up
  items there once published).
- Windows support: node-pty works on Windows but the daemon helpers inherit
  `@tejika/process`'s POSIX stance (see
  `docs/agents/plans/backlog/2026-07-06-env-paths-hardening.md`).
- Screen-diff/snapshot utilities, scripted expect-style DSLs — YAGNI until a
  consumer needs them.

## Docs to update with the implementation

- `AGENTS.md` package overview table (+ `test/` row).
- `docs/agents/architecture.md` package graph.
- Package README per publishing conventions.
