# Port and CLI option validation — design

**Date:** 2026-07-13
**Packages:** `@tejika/env`, `@tejika/cli`
**Origin:** repo audit 2026-07-02 (findings H6, H7 + `@tejika/cli` mediums/lows),
captured as `docs/agents/plans/next/2026-07-06-port-and-cli-option-validation.md`.

## Problem

1. **H6 — env port overrides are barely validated.** `getPort` uses
   `Number.parseInt`, so `MYAPP_PORT='80abc'` resolves to `80`, `'80.5'` to `80`,
   `'0x50'` to `0`. There is no range check either: `0`, `-1` and `70000` all pass
   through. `0` is the worst of them — it means "any port" to the OS, silently
   defeating the pin the operator set.
2. **H7 — `--port` is unvalidated and the preAction hook targets the wrong
   command.** The option has no argParser, so a CLI-supplied value stays a raw
   string while the env-resolved default is a number; consumers get
   `string | number` with no integer or range check (`-p -1` yields `"-1"`). The
   hook reads and writes `actionCmd` (the leaf action command) although the option
   is registered on `cmd`, so with subcommands a user-supplied `-s`/`-p` on the
   parent is ignored and the default is written to the wrong command.
3. **`getPort`'s `default` is a preference, not a pin.** When the default port is
   already taken, get-port silently returns a different random port. That is right
   for a server choosing a listen port and wrong for a client dialing a known
   server: the client asks for 4000, the server is *on* 4000, get-port sees it
   taken and hands back a random port the client can never connect to.
4. **`withPort` cannot express the client case at all** — it exposes no way to pass
   `getPort`'s `default` through, so with no env override every invocation resolves
   a random free port.
5. **`runInk` silently inverts Ink's default** with `exitOnCtrlC: false`: an app
   that does not implement its own Ctrl+C handling becomes unquittable, because raw
   mode swallows the signal.
6. Smaller gaps: `withSocketPath` does not expose `getSocketPath`'s `name`;
   `withLogLevel` accepts any string; the `withPort` doc comment describes the wrong
   `parse()` failure mode; `withSocketPath`/`withPort` have zero test coverage.

## Design

### `@tejika/env`

New exported validator, the single source of truth for what a port is:

```ts
export function parsePort(value: string, label?: string): number
```

Trims the value, requires `/^\d+$/`, requires `1 <= n <= 65535`. On failure it
throws an `Error` naming the source — `label` is the env var name
(`MYAPP_PORT`) when called from `getPort`, so the existing error message shape is
preserved. Rejects `'80abc'`, `'80.5'`, `'0x50'`, `'0'`, `'-1'`, `'70000'`.

Two resolvers, both applying `parsePort` to any env override:

```ts
export async function getPort(
  app: string,
  opts?: { default?: number; host?: string },
): Promise<number>

export function resolvePort(app: string, defaultPort: number): number
```

- `getPort` keeps its probing semantics (server side): env override wins, otherwise
  get-port finds a free port, preferring `opts.default`. `host` is a new passthrough
  to get-port.
- `resolvePort` is synchronous and does no I/O (client side): env override wins,
  otherwise `defaultPort` verbatim. It validates `defaultPort` through `parsePort`
  too, so a bad literal fails loudly at the call site.

Naming over flags: `getPort` vs `resolvePort` says which one probes. A boolean on a
single function would hide that behind a footnote, and `resolvePort` needs no
`await`.

### `@tejika/cli` — option builders

```ts
export function withSocketPath(cmd: Command, app: string, opts?: { name?: string }): Command
export function withPort(
  cmd: Command,
  app: string,
  opts?: { default?: number; exact?: boolean; host?: string },
): Command
export function withLogLevel(
  cmd: Command,
  opts?: { levels?: Array<string>; default?: string },
): Command
export const DEFAULT_LOG_LEVELS: Array<string>
```

**`withPort`**

- The option gets an argParser that calls `parsePort` and rethrows any failure as
  commander's `InvalidArgumentError`, so a CLI-supplied value arrives as a validated
  `number`. The option type is `number`, never `string | number`.
- **Hook target (H7 fix):** the preAction hook reads and writes the *hooked* command
  — the one that owns the option — not the action command. Commander stores an
  option's value on the command where it was declared, so this is where a
  user-supplied value already is and where the default must go. A leaf action reads
  an ancestor's option via `optsWithGlobals()`; that is documented on the builder.
- **Mode split, mirroring the env API:**
  - no `exact` → async preAction hook calling `getPort` (probes; `opts.default` is a
    preference, `host` is passed through). Async hooks are only awaited under
    `parseAsync`, which the doc comment states.
  - `exact: true` (requires `default`) → **synchronous** preAction hook calling
    `resolvePort`, so such a command also works under plain `parse()`.
  - `exact` without `default` throws at registration — an unsatisfiable request,
    caught at build time rather than at parse time.

**`withSocketPath`** passes `opts.name` to `getSocketPath(app, name)` for
multi-socket apps. Its hook gets the same hooked-command fix.

**`withLogLevel`** applies `.choices(levels)`. `DEFAULT_LOG_LEVELS` is
`['trace', 'debug', 'info', 'warning', 'error', 'fatal']` — LogTape's set, which
`@sozai/log` re-exports, so a consumer can wire the flag straight into the logger
with no mapping layer. The current `warning` default is already a member. The list is
inlined rather than imported: tejika has no `@sozai/*` dependency and this design does
not add one. `opts.levels` lets a consumer on another logger supply its own set;
`opts.default` overrides `warning`.

### `@tejika/cli` — `runInk`

Drop `exitOnCtrlC: false`; pass `options` through to Ink untouched. Ink's default
(`exitOnCtrlC: true`) then applies and every app is quittable out of the box. An app
that wants to intercept Ctrl+C passes `{ exitOnCtrlC: false }` itself and takes on the
duty. This is a behaviour change for any consumer relying on the silent inversion; the
packages are pre-1.0 and the only consumers in-repo are `@tejika/ui` and `@tejika/test`.

Exit-code/error mapping and a non-TTY guard for `runInk` are **out of scope** — they are
policy decisions about who owns `process.exit` — and move to a new backlog item.

## Error handling

- Invalid env override → `Error` from `parsePort` naming the variable and the value.
  Thrown from `getPort`/`resolvePort`, i.e. at resolution time, as today.
- Invalid `--port` on the command line → commander's `InvalidArgumentError`, which
  commander renders as a usage error with help (the program sets
  `showHelpAfterError`).
- Invalid `--log-level` → commander's `.choices()` error listing the allowed values.
- `withPort(cmd, app, { exact: true })` with no `default` → `Error` thrown
  synchronously at registration.

## Testing

`@tejika/env` (`test/ports.test.ts`):

- `parsePort` rejects `'80abc'`, `'80.5'`, `'0x50'`, `'0'`, `'-1'`, `'70000'`,
  `''`/whitespace; accepts `'1'`, `'65535'`, and a padded `' 8080 '`.
- `getPort` throws the descriptive error for each invalid override; returns the
  override when valid; falls back to a free port otherwise.
- `resolvePort` returns the env override when set, the default verbatim otherwise,
  throws on an invalid override and on an invalid `defaultPort`.

`@tejika/cli` (`test/options.test.ts` — `withSocketPath`/`withPort` currently have no
tests at all):

- default injection: with no flag, the action sees the env-resolved value.
- precedence: an explicit `-s`/`-p` beats the env default.
- env override honoured when set after the program is built (the reason the hook is
  lazy).
- invalid `-p` produces the `InvalidArgumentError` message; a valid one arrives as a
  `number`.
- **parent-command `-s`/`-p` respected with a subcommand** (the H7 regression).
- `exact` mode resolves under synchronous `parse()`; `exact` without `default` throws
  at registration.
- `withSocketPath` `name` passthrough; `withLogLevel` accepts a listed level and
  rejects an unlisted one.

`runInk`: the existing PTY integration test gains a Ctrl+C-quits assertion.
`ink-testing-library` is a declared but unused dev dependency — use it to cover
`renderStatic`, or drop the dependency.

The `withPort` doc comment (`options.ts:24-27`) states the wrong `parse()` failure
mode, and the CLI fixture models that same misunderstanding; the async/sync split
rewrites both anyway.

## Acceptance

- Invalid env port overrides throw the descriptive error; valid `1`–`65535` pass.
- `-p`/`--port` parses to a validated number; invalid values produce commander's
  `InvalidArgumentError`.
- Parent-command `-s`/`-p` are respected with subcommands.
- A client command can pin an exact port without probing.
- `runInk` apps are quittable with Ctrl+C unless they opt out.
- New tests green; `pnpm test` and `pnpm lint` green.

## Follow-up

- `docs/agents/plans/next/2026-07-06-port-and-cli-option-validation.md` is consumed by
  this spec and deleted.
- New backlog item: `runInk` exit-code/error mapping and non-TTY guard.
