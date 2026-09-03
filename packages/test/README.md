# @tejika/test

Integration-test primitives for CLIs built on the `@tejika/*` stack. Install
as a devDependency.

```sh
pnpm add -D @tejika/test
```

- `PTYDriver` — drive a real terminal app over node-pty (Ink needs a TTY on
  stdin). Buffered `screen()` with ANSI stripped, `waitFor*` polling,
  windowed reads (`mark`/`screenSince`/`screenAfterLast`), key helpers,
  `type()` at human speed, `Disposable`. Subclass it for app-specific flows.
- `runCLI` — run a non-interactive command to completion; never rejects
  (spawn failures land in the result).
- `createTestProfile` — throwaway temp dir with `<APP>_<KEY>` env overrides
  (via `@tejika/env`), `AsyncDisposable` with an `onDispose` hook for daemon
  teardown.
- `waitForDaemonRunning` / `waitForDaemonStopped` — poll a pidfile via
  `@tejika/process`; running throws on timeout, stopped tolerates it.
- `poll` — the shared truthy-poll primitive.
- `assertBuilt` / `rebuild` — vitest globalSetup helpers for tests that spawn
  built binaries.

## Troubleshooting

### `posix_spawnp failed` when spawning a PTY

`node-pty` ships a prebuilt `spawn-helper` binary that must be executable. Some
installs (notably pnpm's content-addressed store hardlinks) can land it without
the executable bit, so `PTYDriver` fails with `posix_spawnp failed`. Restore it:

```sh
find node_modules -type f -name spawn-helper -exec chmod +x {} +
```

CI runners that install fresh may need the same step before running PTY-backed
tests. (This repo's own `test-platforms.yml` workflow already does this.)
