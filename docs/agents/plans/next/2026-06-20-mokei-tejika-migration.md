# Migrate Mokei to consume `@tejika/*`

**Priority:** next
**Origin:** deferred Task 6 of the tejika packages extraction (see
`../completed/2026-06-20-tejika-packages-extraction.partial.md`).
**Where:** performed in the `../mokei` repo, not `tejika`.

## Goal

Make Mokei the first consumer of the five `@tejika/*` packages (all published at
`0.1.0`). This proves the extracted APIs and deletes Mokei's now-duplicated
implementations.

## Precondition

The five `@tejika/*` packages exist and are green: `@tejika/env`,
`@tejika/process`, `@tejika/server`, `@tejika/cli`, `@tejika/ui`. Tejika is a
separate sibling repo (siblings under one parent). Decide the cross-repo link
mechanism Mokei will use (local `link:`/workspace during dev, or a published
version) as the first step — it affects every package.json edit below.

## `@tejika/*` public APIs to consume

- **`@tejika/env`**: `getDataDir(app)`, `getStateDir(app)`,
  `getSocketPath(app, name?)`, `getPIDPath(app)`,
  `getPort(app, opts?: { default?: number; host?: string })`,
  `resolvePort(app, defaultPort)` (sync, non-probing client-side counterpart of
  `getPort`), `parsePort(value, label?)` (the shared strict port validator: an
  integer in `1..65535`, rejecting `'80abc'`/`'80.5'`/`'0x50'`/`0`), `appEnvVar(app, key)`.
  Each resolver honours an `<APP>_<KEY>` env override first. **Breaking as of
  2026-07-13:** `getPort`/`resolvePort` now throw on malformed or out-of-range
  `<APP>_PORT` overrides and on an invalid `default`/`defaultPort`, instead of
  silently accepting them.
- **`@tejika/process`**: `runDaemon`, `spawnDaemon`, `createDaemonClient`
  (reconnect backoff 250ms–5s), `ensureDaemon`, `getDaemonStatus`, `stopDaemon`.
  Generic over the Enkaku `Protocol`; `app: string` replaces baked-in paths.
- **`@tejika/server`**: `createLocalServer(opts)` (loopback default + network
  mode), `buildAllowedHosts`, `verifyLoopbackRequest`, `attachEnkakuTransport`,
  `serveStaticSPA`. Preserves the Host/Origin/timing-safe-token/`chmod 0o600`
  defenses.
- **`@tejika/cli`**: `buildProgram`, `runInk`, `renderStatic`, `withSocketPath`,
  `withPort`, `withLogLevel`, `DEFAULT_LOG_LEVELS` (LogTape's level set:
  `trace debug info warning error fatal`, immutable). NOTE: a program using
  `withPort` MUST run via `program.parseAsync()` (the lazy default uses an async
  preAction hook), unless `withPort` is called with `{ exact: true }`, whose hook
  is synchronous.

  **Migration warning — `optsWithGlobals()` break:** `withPort`'s and
  `withSocketPath`'s preAction hooks now write the resolved default onto the
  command the option is registered on (its owner), not onto the leaf action
  command as Mokei's current code relies on. Concretely: if `--port`/
  `--socket-path` is registered on a parent command and a subcommand's `action`
  handler reads its `options` argument (equivalently, calls `opts()` on itself),
  it will now see `undefined` instead of the resolved value. Every such leaf
  action must be changed to read `optsWithGlobals()` instead. Audit Mokei's
  `cli/src/program.ts` subcommand actions for this pattern before cutting over.
- **`@tejika/ui`**: `StatusLine`, `Footer`, `KeyHints`, `ConfirmCard`,
  `SelectCard`, `Spinner`, `IconLine`, `SystemNotice` (generic, props-only).

## Migration steps (in `../mokei`)

1. **Decide + apply the cross-repo link strategy.** Add `@tejika/*` deps to the
   relevant Mokei packages.
2. **`@mokei/host` → `@tejika/process` + `@tejika/env`.** Replace
   `daemon/controller.ts`, `daemon/process.ts`, the socket-server block in
   `server.ts`, and the daemon bits of `spawn.ts` with `@tejika/process` imports;
   delete the now-dead local code. `pnpm --filter @mokei/host test` stays green.
3. **`@mokei/host-monitor` → `@tejika/server`.** Replace `auth.ts`/`index.ts`
   server construction with `createLocalServer(...)` + `serveStaticSPA(...)`; keep
   the monitor's host-protocol stream wiring. `pnpm --filter @mokei/host-monitor
   test` stays green.
4. **`@mokei/cli` → `@tejika/cli` + `@tejika/ui`.** Replace `program.ts`/`ink.ts`/
   `options.ts` with `@tejika/cli`; swap the generic chat components for
   `@tejika/ui` equivalents; leave chat-domain components (AssistantMessage,
   ToolApprovalCard, etc.) local. `pnpm --filter @mokei/cli test` stays green.
5. **Full Mokei verification + commit.** `pnpm build && pnpm test && pnpm lint`
   in `../mokei`, all green.

## Donor → tejika mapping (the code that moved, for diffing against the originals)

- `@tejika/env` ← a consumer CLI's `apps/cli/src/paths.ts` + Mokei get-port usage.
- `@tejika/process` ← Mokei `host/src/daemon/{controller,process,socket}.ts`,
  `host/src/server.ts`, `host/src/spawn.ts` + a consumer CLI's
  `apps/cli/src/daemon/{controller,lifecycle,host}.ts`.
- `@tejika/server` ← Mokei `host-monitor/src/{index,auth,html,pipes}.ts`.
- `@tejika/cli` ← Mokei `cli/src/{program,ink,options}.ts`.
- `@tejika/ui` ← Mokei `cli/src/chat/components/*.tsx` (chat domain stripped).
