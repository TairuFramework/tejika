---
"@tejika/cli": minor
"@tejika/log": minor
"@tejika/ui": minor
---

`@tejika/cli`: add `withCommandSignal`, `addJSONOption`, `printJSON`, `printNDJSON`,
`parseJSONArg`, `fail`, `renderTable` and `withPIDPath`, plus `createDaemonCommand({ app, entry })`,
a generic `daemon start|stop|status|restart|logs` group over `@tejika/process`. All subcommands
honor a custom `--pid-path`. `@tejika/cli` now depends on `@tejika/process` and `@tejika/log`.

`@tejika/log`: add `followLog(path, { signal })` (also `@tejika/log/follow`). `@logtape/logtape`
is now an optional peer dependency, since `followLog` does not use it.

`@tejika/ui`: add `ExitOnAbort` and `InterruptOnCtrlC`.
