# Two low-severity findings from the port-and-CLI-option-validation final review

**Priority:** backlog
**Origin:** final whole-branch review of `2026-07-13-port-and-cli-option-validation`
(both were noted during that review, out of scope for the branch, and not
otherwise backlogged).
**Where:** `packages/cli/src/program.ts`; `packages/server/src/server.ts`.

## 1. `showHelpAfterError` is not applied recursively to pre-existing nested subcommands

`buildProgram` (`packages/cli/src/program.ts`) only calls `showHelpAfterError()`
on the top-level program and on each command passed directly in `opts.commands`:

```ts
for (const command of opts.commands) {
  program.addCommand(command)
  command.showHelpAfterError()
}
```

A command's own pre-existing subcommands (added via `command.addCommand(...)`
before it is passed to `buildProgram`) never get the call, so a usage error two
levels deep prints commander's terse one-liner instead of full help. Fix by
walking `command.commands` recursively when applying `showHelpAfterError()`.

## 2. `createLocalServer({ port })` accepts a caller-supplied port unvalidated

`packages/server/src/server.ts:59`:

```ts
const port = opts.port ?? (await getPort(opts.app))
```

`getPort`'s own default path is now validated (see the port-and-CLI-option-
validation branch), but a caller-supplied `opts.port` bypasses it entirely —
`createLocalServer({ app, port: 0 })` still binds an ephemeral port, the exact
footgun the env-side validation exists to close. `port` should be run through
`@tejika/env`'s `parsePort`/the same range check before use (or `createLocalServer`
should accept `port` as already-validated and document that contract clearly).
