# Port and CLI option validation

**Status:** complete
**Date:** 2026-07-13
**Packages:** `@tejika/env`, `@tejika/cli`
**Origin:** repo audit 2026-07-02 (findings H6, H7 + the `@tejika/cli` mediums/lows),
step 4 of that audit's order of attack.

## Goal

Make a port validated everywhere it enters the system — the env override and the
`--port` flag — and fix the `@tejika/cli` option builders (wrong preAction hook
target, missing passthroughs, a silent inversion of Ink's Ctrl+C default).

## What was wrong

- `getPort` validated env overrides with `Number.parseInt`, which accepts `'80abc'`
  (→ 80), `'80.5'` (→ 80) and `'0x50'` (→ 0), and applied no range check. `MYAPP_PORT=0`
  therefore passed straight through — and `0` means "any port" to the OS, silently
  defeating the pin an operator had just set.
- `--port` had no argParser: a CLI-supplied value stayed a raw string while the
  env-resolved default was a number, so consumers saw `string | number` with no
  integer or range check (`-p -1` yielded `"-1"`).
- The option builders' preAction hooks read and wrote the leaf **action** command
  while the option is registered on the **hooked** command. Commander stores an
  option's value on the command where it was declared, so with subcommands a
  user-supplied `-p`/`-s` on the parent was silently ignored.
- `getPort`'s `default` was a preference, not a pin: when the port was taken, get-port
  quietly returned a different one. Correct for a server choosing a listen port,
  wrong for a client dialing a known server — the client asks for 4000, the server
  *is* on 4000, get-port sees it taken and hands back a port nothing is listening on.
- `runInk` forced `exitOnCtrlC: false`, inverting Ink's default. Ink's raw mode
  swallows SIGINT, so any app that did not implement its own Ctrl+C handling was
  literally unquittable.

## Key design decisions

**One validator, in `@tejika/env`.** `parsePort(value, label?)` is the single source of
truth for "what is a port": trims, requires `/^\d+$/`, requires `1 <= n <= 65535`.
`getPort`, `resolvePort` and `@tejika/cli`'s `--port` argParser all call it, so the rule
cannot drift between the env path and the CLI path. `0` is rejected by design.

**Two port resolvers, named for what they do, rather than one function with a flag.**
`getPort(app, { default?, host? })` is async and probes for a free port (server side).
`resolvePort(app, defaultPort)` is synchronous, does no I/O, and returns the env override
or the default verbatim (client side). A boolean on a single function would have hidden
the probing behaviour behind a footnote, and `resolvePort` needs no `await`.

**`withPort` mirrors the env API.** No `exact` → async preAction hook + `getPort` (which
requires `parseAsync()`, since commander only awaits hooks there). `exact: true` (which
requires `default`) → **synchronous** hook + `resolvePort`, so a client command also works
under plain `parse()`. `exact` without `default` throws at registration — an unsatisfiable
request, caught at build time.

**Hooks target the option's owner.** Every option-builder hook now reads and writes the
command the option is registered on, not the leaf action command. See the breaking-change
note below — this is the one with downstream teeth.

**Ink's default wins.** `runInk` passes options through untouched, so every app is
quittable out of the box; an app that wants to intercept Ctrl+C passes
`{ exitOnCtrlC: false }` itself and takes on the duty.

**Log levels are LogTape's set** (`trace debug info warning error fatal`, exported as
`DEFAULT_LOG_LEVELS`, frozen), inlined rather than imported — tejika takes no `@sozai/*`
or `@logtape/*` dependency. A consumer on another logger passes its own `levels`.
`withLogLevel` throws at registration if the effective default is not in the effective
level set: commander's `.choices()` only guards a *parsed* value and never validates the
default, so without the guard a caller could ship a default its own flag would reject.

## Breaking changes (recorded for release notes in `next/2026-07-06-publishing-readiness.md`)

Both packages are published and pre-1.0. The repo has no changesets infrastructure, so
these are tracked in the publishing-readiness item until release automation exists.

1. `@tejika/env`: `getPort` now throws on `MYAPP_PORT` values it previously accepted
   (`'80abc'`, `'80.5'`, `'0x50'`, `0`, `-1`, `70000`).
2. `@tejika/cli`: `--port` is a `number`; it was a raw `string` when supplied on the
   command line.
3. `@tejika/cli`: **a leaf action can no longer read an ancestor's `--port`/`--socket-path`
   via `opts()`** — it must use `optsWithGlobals()`. This is the subtle one. The old hook
   wrote the resolved default onto the *leaf*, so `sub.action((options) => options.port)`
   worked; the fix moves the value to the option's owner, so that same code now silently
   receives `undefined`. The fix is still correct (the old hook ignored a user-supplied
   parent `-p` entirely), but downstream consumers must migrate. Flagged in
   `next/2026-06-20-mokei-tejika-migration.md`.
4. `@tejika/cli`: `runInk` no longer suppresses Ctrl+C.

## What was built

`@tejika/env`: `parsePort`, a validating `getPort` with a `host` passthrough, and
`resolvePort`. Invalid `default` arguments are rejected unconditionally — including when
an env override is present, so a bad literal fails loudly at the call site regardless of
the environment.

`@tejika/cli`: `withPort` (argParser + hooked-command target + `exact` mode + registration-
time `default` validation), `withSocketPath` (`name` passthrough + hooked-command target),
`withLogLevel` (`.choices()` + `DEFAULT_LOG_LEVELS` + caller-overridable `levels`/`default`),
and `runInk` without the Ctrl+C override. The unused `ink-testing-library` dev dependency
was dropped (`@tejika/ui` keeps its own).

Test coverage went from zero on `withSocketPath`/`withPort` to pinning every behaviour
above, including **storage-location** regression tests: two review rounds found that a test
reading the leaf's `optsWithGlobals()` *cannot* detect a hook writing to the wrong command,
because commander merges ancestors after self and the correct ancestor value always masks
the buggy descendant write. The regression tests assert on each command's own `opts()`
instead, and were verified to fail against the pre-fix hook.

## Status

Complete. Repo green: build 6/6 packages, 254 tests across 9 test tasks, biome clean.

## Follow-ups filed

- `backlog/2026-07-13-runink-exit-codes-and-non-tty-guard.md` — `runInk` has no error-to-exit-code
  mapping and no non-TTY guard. Both are policy calls about who owns `process.exit` in a library
  apps embed, so they were cut rather than guessed at; decide with a real consumer in hand.
- `backlog/2026-07-13-help-recursion-and-server-port-validation.md` — `showHelpAfterError` is not
  applied recursively to pre-existing nested subcommands (an audit finding that would otherwise
  have been lost), and `createLocalServer({ port })` still takes a caller-supplied port completely
  unvalidated, so `port: 0` binds an ephemeral port — the exact hazard the env path now rejects.
