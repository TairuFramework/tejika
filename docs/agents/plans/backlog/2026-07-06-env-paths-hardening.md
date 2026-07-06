# Harden `@tejika/env` paths: XDG state dir, socket length, Windows, `getPIDPath` rename

**Priority:** backlog (audit mediums — "as convenient"; port validation is split
out into `next/2026-07-06-port-and-cli-option-validation.md`)
**Origin:** repo audit 2026-07-02 (`@tejika/env` mediums/lows + the single
conventions violation found repo-wide).
**Where:** `packages/env/src/paths.ts`, `packages/env/src/ports.ts`, `packages/env/test/`; rename ripples into `@tejika/process`.

## Conventions

- `packages/env/src/paths.ts:20` — `getPidPath` violates the "uppercase
  abbreviations" guardrail (`ID` not `Id`): rename to `getPIDPath`
  (cross-package rename; `@tejika/process` consumes it). This was the **only**
  guardrail violation found repo-wide. Breaking change — coordinate with a
  minor/major bump and update consumers.

## Medium severity

- `src/paths.ts:9-11` — `getStateDir` actually returns `envPaths(...).config`;
  per XDG, state (pid files) belongs in `$XDG_STATE_HOME` / `~/.local/state`.
  Rename to `getConfigDir` or compute a real state dir.
- `src/paths.ts:13-18` — no socket-path length guard: unix `sun_path` is
  104 bytes on macOS / 108 on Linux, and the macOS data dir
  (`~/Library/Application Support/<app>/…`) plus a long username can exceed
  it — confusing `bind()` failure. Validate byte length and throw a
  descriptive error.
- `src/paths.ts:13-18` — no Windows handling: IPC endpoints must be named
  pipes (`\\.\pipe\<name>`); a `.sock` path under `%LOCALAPPDATA%` cannot be
  bound. Branch on `win32` or document the package as POSIX-only (applies to
  `@tejika/process` as a whole too) — decide which.
- `src/paths.ts:14-16` — override/name interaction is surprising: if
  `MYAPP_SOCKET_PATH` is set but the caller asks for a named socket, the
  override is silently ignored. Document the rule or derive named sockets
  relative to `dirname(override)`.

## Low severity

- `name`/`app` not sanitized against path separators in
  `getSocketPath`/`getPIDPath`.
- App names starting with a digit produce un-settable env vars.
- Override values are trimmed — document the behavior.

## Acceptance

- `getPIDPath` exported (old name removed), `@tejika/process` and docs
  updated, everything green.
- State-dir semantics match XDG (or the function is renamed to what it
  actually returns).
- Over-length socket paths throw a descriptive error with the limit in the
  message; tests cover it.
- Windows stance decided and either implemented or documented in the README
  and `docs/agents/architecture.md`.
