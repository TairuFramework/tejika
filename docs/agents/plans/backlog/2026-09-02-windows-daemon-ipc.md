# Windows daemon lifecycle + Enkaku IPC over named pipes

**Origin:** env-paths hardening (see
`docs/agents/plans/completed/2026-09-02-env-paths-hardening.complete.md`) added
Windows named-pipe support to `@tejika/env` (`getSocketPath` returns
`\\.\pipe\<name>` on win32) and gated the filesystem-only socket steps in
`@tejika/process` on `isNamedPipe`. The cross-platform CI matrix
(`.github/workflows/test-platforms.yml`) then confirmed that path resolution,
pipe-string handling, the length guard, and sanitization all pass on Windows,
macOS, and Linux, and that a single directly-spawned daemon comes up on Windows
(`daemon-lifecycle.integration` passes there). But the full daemon-lifecycle +
Enkaku IPC stack does not yet run over Windows named pipes end to end.

The Windows CI leg (`.github/workflows/test-platforms.yml`) therefore excludes
`@tejika/process` and `@tejika/test` (`turbo run test --filter=!@tejika/process
--filter=!@tejika/test`) and runs only the Windows-ready packages. Re-including
them is the finish line for this follow-up.

## What fails on Windows today (excluded, not fixed)

- **`@tejika/test` `daemon-concurrency.integration.test.ts`** (skipped on
  win32): racing the detached `ensureDaemon` cold-start across separate OS
  processes, the daemon child never writes its pidfile (`ENOENT ...<app>.pid`)
  and the Enkaku client fails with `TransportDisposed`. So either the detached
  daemon spawn in `@tejika/process` `spawn.ts` does not bring the child up on
  Windows, or the Enkaku transport does not connect over a `\\.\pipe\` name — or
  both.
- **The entire `@tejika/process` test suite** (`client`, `controller`, `daemon`,
  `mutex`, `socket`, `spawn`, `state`, `stop`): the tests bind a `net` server on
  a POSIX `.sock` filesystem path (or pass an explicit `--socket-path
  '…\app.sock'` to the daemon fixture), and Windows `net` listens only on
  `\\.\pipe\` names — a `.sock` path yields `EACCES`. So the whole daemon/socket
  layer, and its tests, assume POSIX unix-domain sockets.

Because the failure is the whole package's socket model rather than a handful of
cases, the fix is a real port, not per-test skips — the packages are excluded
wholesale from the Windows CI leg (above) until the port lands.

## Also flaky (unrelated to Windows)

`@tejika/process` `controller.test.ts` → "two concurrent cold starts with a
defaulted pidPath both get a working client" fails intermittently on macOS/Linux
(observed: the state file did not yet contain `"ready":true` when asserted) — a
timing race in the test, worth hardening independently of the Windows port.

## Work to do

1. **Detached daemon spawn on Windows.** Determine why the `ensureDaemon`-spawned
   daemon child does not start / write its pidfile on Windows (inspect
   `@tejika/process` `spawn.ts` detach semantics — `detached`, `stdio`,
   `windowsHide`, and how the entry command is resolved). Fix so the daemon
   boots and writes its pidfile on Windows.
2. **Enkaku IPC over named pipes.** Confirm whether `@enkaku/socket`'s client and
   server transports connect over a `\\.\pipe\<name>` address. If they do not,
   fix it at the Enkaku source repo (per the project guardrail: never work
   around `@enkaku/*` bugs here) and raise the version floor once released.
3. **Harness socket paths.** Make the `@tejika/process` and `@tejika/test` daemon
   tests and helpers use a platform-appropriate socket path — a `\\.\pipe\` name
   on Windows (e.g. via `getSocketPath` rather than a hard-coded `.sock`) — so the
   bind/probe/liveness paths are exercised there too.
4. **Re-include the packages on Windows** by dropping the
   `--filter=!@tejika/process --filter=!@tejika/test` exclusion in
   `.github/workflows/test-platforms.yml`, and confirm the full matrix is green.

## Validation

`.github/workflows/test-platforms.yml` (ubuntu/macos/windows × node 24/26) is the
gate: the follow-up is done when `@tejika/process` and `@tejika/test` run and pass
on the Windows jobs with the filter exclusion removed.
