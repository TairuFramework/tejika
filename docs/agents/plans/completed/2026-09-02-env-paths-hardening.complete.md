# Harden `@tejika/env` paths — complete

**Status:** complete
**Date:** 2026-09-02
**Branch:** env-paths-hardening
**Origin:** repo audit 2026-07-02 (`@tejika/env` mediums/lows).

## Goal

Close the medium/low findings against `@tejika/env`'s path helpers: Windows IPC
support, a POSIX socket-path length guard, a predictable override/name rule, and
input sanitization — without moving the pidfile or renaming the already-correct
helpers.

## Key design decisions

- **`getStateDir` kept as-is**, returning `envPaths(app).config`. `env-paths`
  exposes only `data`/`config`/`cache`/`log`/`temp` — no dedicated state bucket,
  and its `log` bucket is `~/Library/Logs` on macOS (a log location, not state).
  `.config` is the sanest existing home for the pidfile, and the pidfile location
  must not move. The audit's "rename to `getConfigDir` or compute a real state
  dir" was intentionally declined.
- **Windows: named pipes, not POSIX-only.** `getSocketPath` returns
  `\\.\pipe\<name>` on `win32`. Because a named pipe has no filesystem entry,
  `@tejika/env` also exposes `isNamedPipe(path)`, and `@tejika/process` uses it to
  skip the filesystem-only socket steps (parent-dir `mkdir`, `chmod` after bind,
  stale-file cleanup) while still probing pipe liveness for foreign-daemon
  detection. This is what actually makes the process package cross-platform, not
  the path string alone.
- **`SOCKET_PATH` override is a directory anchor.** On POSIX, override + a `name`
  resolves to `join(dirname(override), name + '.sock')`; override + no name is
  verbatim. On win32 a `name` always yields `\\.\pipe\<name>`, ignoring the
  override; no name uses the override verbatim.
- **Socket-length guard reserves the NUL.** `sun_path` holds 104 bytes on darwin /
  108 on linux *including* the terminating NUL, so the usable pathname limit is
  103/107. The guard rejects `> 103/107` (not `> 104/108`, which let an
  exactly-full path through to a cryptic `bind()` failure) with a message naming
  the byte count, platform, limit, and the `<APP>_SOCKET_PATH` override variable.
  Skipped on win32.
- **Input sanitization.** `getSocketPath` rejects `/`, `\`, or `..` in `app`/`name`
  (an IPC-path traversal is a caller bug worth surfacing). `appEnvVar`
  underscore-prefixes a digit-leading slug (`1app` → `_1APP_…`) so the env var is
  settable in POSIX shells. Override values are trimmed (documented).

## What was built

- `@tejika/env`: `getSocketPath` gained separator rejection, override-anchor
  derivation, the POSIX byte-length guard, and the win32 named-pipe branch; new
  exported `isNamedPipe`; `appEnvVar` digit-prefix; doc comments; unit tests for
  every branch (platform mocked via `process.platform`).
- `@tejika/process`: `daemon.ts`, `spawn.ts`, and `socket.ts` gate every
  filesystem-only socket operation on `isNamedPipe`; `safeRemove` is a no-op for
  pipes; a `@tejika/cli` test updated to the new override-anchor semantics.
- Docs: `docs/agents/architecture.md` records the POSIX/pipe split, the 103/107
  usable limit, and the `isNamedPipe` skip contract.

Docs deviation: the audit named a package README, but `packages/env` has none —
the note landed in `docs/agents/architecture.md` instead.

## Validation

Full `pnpm build` + `pnpm test` (all packages) + `biome ci` green on this macOS
host. Two Codex review passes: the first surfaced the win32 filesystem-op gap and
the `sun_path` NUL off-by-one (both fixed in this branch); the second was clean.
The win32 code paths cannot run on macOS, so a cross-platform CI matrix
(ubuntu/macos/windows × node 24/26) was added in
`.github/workflows/test-platforms.yml` to exercise them on real runners.

On that matrix, all unit suites — `@tejika/env` (path resolution, named-pipe
strings, length guard, sanitization), `@tejika/process`, `@tejika/server`, and
the rest — pass on Windows, macOS, and Linux, and the full suite passes on macOS
and Linux. Getting there fixed several OS-portability issues in the tests
themselves (platform-pinned `.sock` assertions, `node:path`-derived expectations
for the Windows separator, a hardware-independent concurrency floor, and an
absolute `process.execPath` for node-pty's Windows agent) plus a pnpm/node-pty
`spawn-helper` exec-bit step on macOS. Two Windows gaps remain deferred: the
node-pty conpty backend crashes its vitest worker on Windows Server 2025 (an
upstream bug — the PTY-driven suites are skipped on win32), and the full
daemon-lifecycle + Enkaku IPC stack does not yet run over Windows named pipes
(the daemon-integration suites are skipped on win32). Neither is in the env-paths
path code; both are tracked in the follow-on backlog.

## Follow-on

The two low-severity cleanups extracted to backlog were addressed on this branch
(duplicate `appEnvVar` tests trimmed, the `WithSocketPathOptions.name` doc
corrected). The remaining follow-on is the Windows daemon-IPC port — bringing the
`@tejika/process` daemon lifecycle and `@enkaku` IPC up over Windows named pipes,
then dropping the win32 skips on the daemon-integration and PTY suites — tracked
in `docs/agents/plans/backlog/2026-09-02-windows-daemon-ipc.md`.
