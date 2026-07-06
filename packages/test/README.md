# @tejika/test

Integration-test primitives for CLIs built on the `@tejika/*` stack. Install
as a devDependency.

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
