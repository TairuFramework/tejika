# Validate port inputs (`@tejika/env` + `@tejika/cli`) and fix CLI option plumbing

**Priority:** next (step 4 of the 2026-07-02 audit's order of attack)
**Origin:** repo audit 2026-07-02 (findings H6, H7 + `@tejika/cli` mediums/lows).
**Where:** `packages/env/src/ports.ts`, `packages/cli/src/options.ts`, `packages/cli/src/ink.ts`, `packages/cli/test/`.

## High severity

### H6 — Port override validation too weak (`@tejika/env`)

`packages/env/src/ports.ts:7-12` — `Number.parseInt` accepts `'80abc'` → 80,
`'80.5'` → 80, `'0x50'` → 0; no range check, so `MYAPP_PORT=0`, `-1`, or
`70000` pass through (0 means "any port", silently defeating the pin).

**Fix:** validate with `/^\d+$/` on the trimmed value and require
`1 <= port <= 65535`; throw the existing error otherwise.

### H7 — `--port` unvalidated + preAction hook targets wrong command (`@tejika/cli`)

- `packages/cli/src/options.ts:30-35` — no argParser: a CLI-supplied value
  stays a raw string while the env default is a number, so consumers get
  `string | number` with no range/integer check (`-p -1` yields `"-1"`). Add an
  argParser that validates integer in 1–65535 and throws
  `InvalidArgumentError`.
- `packages/cli/src/options.ts:12-16` — the hook reads/writes `actionCmd` (the
  leaf action command) but the option is registered on `cmd`. With subcommands,
  a user-supplied `-s`/`-p` on the parent is silently ignored and the default
  is set on the wrong command. Use the hooked command (owner of the option),
  not the action command.

## Medium severity

- `src/ink.ts:6` — `runInk` silently inverts Ink's default with
  `exitOnCtrlC: false`: an app that doesn't handle Ctrl+C itself becomes
  unquittable (raw mode swallows the signal). Keep Ink's default or document
  loudly what the app must implement.
- `src/options.ts:29` — `withPort` gives no way to pass `getPort`'s
  `{ default }` through, so with no env override every invocation resolves a
  random free port — meaningless for client commands dialing a known server.
  Add `opts?: { default?: number }`.
- `src/ports.ts:13` (`@tejika/env`) — when `opts.default` is taken, get-port
  silently returns a different random port; callers can't distinguish "got my
  default" from "got a random one". Add an `exact`/`strict` option and a `host`
  passthrough.

## Low severity

- `withSocketPath` doesn't expose `getSocketPath`'s `name` param.
- `withLogLevel` accepts any string (use `.choices()`).
- `showHelpAfterError` not applied recursively to pre-existing nested
  subcommands.
- `runInk` has no exit-code/error mapping and no non-TTY guard.
- `options.ts:24-27` doc comment states the wrong `parse()` failure mode (real
  hazard is fire-and-forget, not undefined option); test fixture models the
  sync-`parse()` footgun — fix both.

## Test backfill (part of acceptance)

- `test/options.test.ts` — `withSocketPath`/`withPort` entirely untested: add
  default injection, precedence, env override, and invalid-port coverage. The
  two nontrivial functions in the package have zero tests.
- `runInk`/`renderStatic` untested despite `ink-testing-library` being declared
  (currently an unused dep) — add coverage or drop the dep.
- `@tejika/env` port tests: `'80abc'`, `'80.5'`, `'0x50'`, `0`, `-1`, `70000`
  all rejected.

## Acceptance

- Invalid env port overrides throw the descriptive error; valid 1–65535 pass.
- `-p`/`--port` on CLI parses to a validated number; invalid values produce
  commander's `InvalidArgumentError` message.
- Parent-command `-s`/`-p` respected with subcommands.
- New tests above green; `pnpm test` and `pnpm lint` green.
