---
"@tejika/cli": patch
"@tejika/log": patch
"@tejika/ui": patch
---

`@tejika/cli`: add `withCommandSignal`, `addJSONOption`, `printJSON`, `printNDJSON`,
`parseJSONArg`, `fail`, `renderTable` and `withPIDPath`, plus `createDaemonCommand({ app, entry })`,
a generic `daemon start|stop|status|restart|logs` group over `@tejika/process`. All subcommands
honor a custom `--pid-path`. `@tejika/cli` now depends on `@tejika/process` and `@tejika/log`.

`@tejika/log`: add `followLog(path, { signal })`.

`@tejika/ui`: add `ExitOnAbort` and `InterruptOnCtrlC`.
