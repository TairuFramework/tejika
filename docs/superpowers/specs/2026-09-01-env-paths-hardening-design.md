# Harden `@tejika/env` paths — design

**Origin:** `docs/agents/plans/next/2026-07-06-env-paths-hardening.md` (repo audit 2026-07-02).
**Where:** `packages/env/src/paths.ts`, `packages/env/src/env-var.ts`, `packages/env/test/`, package README, `docs/agents/architecture.md`.

## Goal

Close the medium- and low-severity findings against `@tejika/env`'s path helpers: Windows IPC support, a socket-path length guard, a predictable override/name interaction, and input sanitization — without moving the pidfile or renaming the existing, already-correct helpers.

## Decisions

These were settled during brainstorming and override the original audit note where they differ:

- **`getStateDir` stays as-is**, returning `envPaths(app).config`. `env-paths` exposes only `data`, `config`, `cache`, `log`, and `temp` — there is no dedicated state bucket. Its `log` bucket maps to `~/.local/state` on Linux but to `~/Library/Logs` on macOS, so it is semantically a log location, not general state. `.config` is the sanest existing bucket for the pidfile, and the pidfile location must not move. The function keeps its name; only its doc comment is clarified. The audit's "rename to `getConfigDir` or compute a real state dir" is intentionally not done.
- **`getPIDPath`** already carries its final name; no rename is outstanding.
- **Windows:** implement named pipes rather than declaring the package POSIX-only.
- **Override + name:** the override acts as a directory anchor — named sockets derive from `dirname(override)`.
- **Over-length socket path:** throw a descriptive error that includes a remediation hint pointing at the `SOCKET_PATH` override.

## Changes

### 1. Windows named pipes — `getSocketPath`

Branch on `process.platform === 'win32'`:

- No override, no name: `\\.\pipe\<app>`
- No override, with name: `\\.\pipe\<name>`
- With override, no name: the override verbatim
- With override, with name: `\\.\pipe\<name>` (the override supplies no directory on Windows; the pipe namespace is flat)

The POSIX branch is unchanged except for the override/name derivation (§3) and the length guard (§2). `@tejika/process` passes the returned path straight to Node's `net` `listen`/`connect`, both of which accept `\\.\pipe\…` on Windows, so no bind-logic change is expected there. The length guard does not run on `win32`.

### 2. Socket-path length guard (POSIX only)

Unix `sun_path` is 104 bytes on darwin, 108 on linux. After computing the POSIX socket path (override or derived), measure `Buffer.byteLength(path)` and compare against the platform limit (`process.platform === 'darwin' ? 104 : 108`). Over the limit throws:

```
socket path <N> bytes exceeds <platform> limit of <L>: <path>. Set <APP>_SOCKET_PATH to a shorter path.
```

`<APP>_SOCKET_PATH` is rendered via the existing `appEnvVar(app, 'SOCKET_PATH')` so the hint names the real variable. The guard is skipped entirely on `win32` (named pipes have no such limit).

### 3. Override / name interaction — `getSocketPath`

The `SOCKET_PATH` override becomes a directory anchor rather than an all-or-nothing value:

- Override + no name (POSIX): override verbatim.
- Override + name (POSIX): `join(dirname(override), `${name}.sock`)`.
- Override (win32): see §1.

This replaces the current "override is used only when `name == null`, otherwise silently ignored" behavior. Documented in the function's doc comment.

### 4. Input sanitization

- **Path separators in `name` / `app`:** reject with a thrown error when either contains `/`, `\`, or a `..` segment. A separator in an IPC path is a caller bug (path traversal / escaping the data dir), worth surfacing loudly rather than silently stripping. Applies in `getSocketPath` (and any helper that interpolates `name`/`app` into a path).
- **Digit-leading app names — `appEnvVar`:** a slug beginning with a digit (`1app` → `1APP_DATA_DIR`) yields an env var name that POSIX shells cannot set. Prefix an underscore when the slug's first character is a digit: `1app` → `_1APP_DATA_DIR`. This changes the computed variable name for digit-leading apps only; all existing (letter-leading) apps are unaffected.
- **Override trimming:** already implemented in `getAppEnvVar` (empty/whitespace treated as unset, value trimmed). Document the behavior in the doc comment; no code change.

### 5. `getStateDir` doc comment

Add a comment noting it returns the config bucket by design, and that pidfiles live there because `env-paths` has no state bucket and its `log` bucket is macOS-Logs, not state.

## Testing

Unit tests in `packages/env/test/` (Vitest):

- win32 pipe forms — mock `process.platform` = `win32`: default, named, override, override+name.
- Over-length POSIX path throws with the expected message (byte count, platform limit, variable-name hint). Cover both darwin and linux limits by mocking `process.platform`.
- Override + name derives via `dirname(override)`; override + no name is verbatim.
- Separator rejection: `/`, `\`, and `..` in `name` and in `app` each throw.
- `appEnvVar` underscore prefix for a digit-leading app; unchanged for a letter-leading app.
- Existing passing tests (`getStateDir` → config, `getPIDPath`, `getLockPath`, empty-override fallbacks) stay green.

Lint/format via `rtk lint biome`.

## Out of scope

- Renaming `getStateDir` / computing a real XDG state dir (explicitly rejected above).
- Any `@tejika/process` bind-logic change (expected unnecessary; if Windows named pipes turn out to need it, that is a follow-up).
- `$XDG_RUNTIME_DIR` for sockets/pidfiles.

## Acceptance

- Over-length POSIX socket paths throw a descriptive error naming the limit and the override variable; tests cover it.
- Windows named pipes implemented for `getSocketPath`; tests cover the pipe forms.
- Override + name derives predictably from `dirname(override)`; documented and tested.
- Separator-bearing and digit-leading inputs handled as specified; tested.
- `getStateDir` unchanged behavior, clarified doc comment.
- README and `docs/agents/architecture.md` reflect the Windows stance (named-pipe support) and the socket-length limit.
- `pnpm build`, `pnpm test`, and `rtk lint biome` all green.
