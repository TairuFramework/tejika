# `spawnDaemon`: override the daemon executable — implementation

**Completed:** 2026-09-01. **Branch:** `feat/spawn-daemon-execpath-override`.
**Origin:** the Sakui desktop daemon-client conversion, which needs to spawn the shared daemon
from inside a packaged Electron build. Filed and fixed upstream here per Sakui's upstream-first
policy rather than worked around downstream.

## Goal

Let a caller choose the executable that runs the daemon entry, so a packaged Electron app — which
has no guaranteed system Node on `PATH` — can start the shared daemon on Electron's own embedded
Node.

## What was built

- **`@tejika/process`: `SpawnDaemonOptions.execPath?: string`**, defaulting to `'node'`.
  `spawnDaemon` now spawns `opts.execPath ?? 'node'` instead of a hardcoded `'node'`
  (`packages/process/src/spawn.ts`). Purely additive; every existing caller (the CLIs) keeps the
  `'node'` default untouched.
- Docstrings updated: `entry` now reads "run with `execPath` (default `node`)", and the
  child-never-started comment generalised from "`node` could not be executed" to "the executable
  could not be run".
- Two tests: a positive path spawning under an explicit `execPath` (`process.execPath`), and a
  negative path asserting a bogus `execPath` fails the boot — the negative proves the option
  actually drives the spawned executable rather than being silently ignored.

## Key design decisions

**Additive option, default preserved.** The one behaviour change is the ability to pass a
different executable; with `execPath` absent the spawn is byte-for-byte what it was. This keeps
the CLIs — the only existing consumers — off the new code path entirely.

**No separate env plumbing for `ELECTRON_RUN_AS_NODE`.** nano-spawn already merges the child `env`
over `process.env` (`{...process.env, ...envOption}`), so the Sakui caller passing
`env: { ELECTRON_RUN_AS_NODE: '1' }` alongside `execPath: process.execPath` is sufficient: the
Electron binary then behaves as `node entry --socket-path … --pid-path …`, and the daemon entry's
existing argv parsing keeps working with no change to `args` construction.

## Caller shape (Sakui desktop)

```ts
await spawnDaemon({
  app: 'sakui',
  entry: bundledDaemonPath,      // asarUnpacked .vite/build/daemon.js
  execPath: process.execPath,    // the Electron binary
  env: { ELECTRON_RUN_AS_NODE: '1' },
})
```

## Status

Complete. `@tejika/process` spawn suite green (6/6 including the two new tests); biome clean;
pre-commit all-package type build green.

## Deferred

Windows named-pipe support for the same Sakui distribution goal is out of scope and tracked in
`docs/agents/plans/backlog/2026-09-01-windows-named-pipe-socket.md`. Not required for the macOS
target; kept separate so the two are not conflated.
