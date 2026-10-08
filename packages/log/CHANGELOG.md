# @tejika/log

## 0.4.2

### Patch Changes

- Update @logtape and @enkaku dependencies

## 0.4.1

### Patch Changes

- `@tejika/cli`: add `withCommandSignal`, `addJSONOption`, `printJSON`, `printNDJSON`,
  `parseJSONArg`, `fail`, `renderTable` and `withPIDPath`, plus `createDaemonCommand({ app, entry })`,
  a generic `daemon start|stop|status|restart|logs` group over `@tejika/process`. All subcommands
  honor a custom `--pid-path`. `@tejika/cli` now depends on `@tejika/process` and `@tejika/log`.

  `@tejika/log`: add `followLog(path, { signal })`.

  `@tejika/ui`: add `ExitOnAbort` and `InterruptOnCtrlC`.

## 0.4.0

### Patch Changes

- Updated dependencies:
  - @tejika/env@0.5.0
