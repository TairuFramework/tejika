# Windows named-pipe support for `getSocketPath` / daemon socket

**Priority:** backlog
**Origin:** split out from the `spawnDaemon` executable-override work; see
`docs/agents/plans/completed/2026-09-01-spawn-daemon-executable-override.complete.md`. Both serve
Sakui's desktop distribution goal, but the macOS target does not need this piece.

## Problem

`@tejika/env` `getSocketPath` always returns `<dataDir>/<app>.sock`. On Windows a Unix-domain
socket path is not the right primitive: the daemon socket needs a named pipe (`\\.\pipe\…`) on
`win32`.

## Scope

- `getSocketPath` should derive a `\\.\pipe\…` path when `process.platform === 'win32'`, keeping
  the `<dataDir>/<app>.sock` shape on other platforms.
- The socket permissioning has to change with it: a named pipe cannot take the consumer's
  `chmod 0o600`, so a Windows-appropriate pipe ACL is needed in place of that call.

## Notes

- Not required for the current macOS Sakui target; filed so it is not conflated with the executable
  override, which shipped without it.
- Touches `@tejika/env` (path derivation) and whichever consumer applies the `0o600` mode today.
