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

## What fails on Windows today (skipped, not fixed)

- **`@tejika/test` `daemon-concurrency.integration.test.ts`** (skipped on
  win32): racing the detached `ensureDaemon` cold-start across separate OS
  processes, the daemon child never writes its pidfile (`ENOENT ...<app>.pid`)
  and the Enkaku client fails with `TransportDisposed`. So either the detached
  daemon spawn in `@tejika/process` `spawn.ts` does not bring the child up on
  Windows, or the Enkaku transport does not connect over a `\\.\pipe\` name — or
  both.
- **`@tejika/test` `daemon.test.ts` → `waitForDaemonRunning` "resolves the pid
  once the pidfile names a live, running daemon"** (skipped on win32): the test
  binds a `net` server on a POSIX `.sock` filesystem path to simulate a live
  daemon, but Windows `net` only listens on `\\.\pipe\` names (a `.sock` path
  gives `EACCES`). The harness needs a platform-appropriate socket path.

These are skipped with `test.skipIf(process.platform === 'win32')` and a comment
pointing here; they still run on macOS and Linux.

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
3. **Harness socket paths.** Make the `@tejika/test` daemon helpers and tests use
   a platform-appropriate socket path — a `\\.\pipe\` name on Windows — so the
   probe/liveness path is exercised there too, then drop the win32 skips.
4. **Re-enable the skipped tests** and confirm the full matrix is green with no
   `skipIf(win32)` guards on the daemon suites.

## Validation

`.github/workflows/test-platforms.yml` (ubuntu/macos/windows × node 24/26) is the
gate: the follow-up is done when the daemon integration suites run and pass on
the Windows jobs with the win32 skips removed.
