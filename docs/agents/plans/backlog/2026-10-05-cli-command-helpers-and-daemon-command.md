# cli, ui -- command plumbing helpers and a generic daemon command group

**Status:** open -- requested by mokei (`@mokei/cli` flow commands)
**Packages:** `@tejika/cli`, `@tejika/ui`
**Origin:** mokei review of its CLI flow, run, inbox and daemon commands

## Command helpers

`@mokei/cli` has plumbing with nothing mokei-specific in it:

- `withCommandSignal(work)` -- runs `work` with a signal that `SIGINT` or `SIGTERM` aborts. It
  removes the listeners afterwards so the process gets its default signal behaviour back.
- `addJSONOption(cmd)`, `printJSON(value)` and `printNDJSON(value)` -- one `--json` convention for
  machine-readable output.
- `parseJSONArg(flag, value)` -- parses a JSON flag value. `@path` reads the value from a file, and
  each error names the flag.
- `fail(error)` -- writes `✘ <message>` to stderr and sets exit code 1.
- `renderTable(columns, rows)` -- static Ink table through `renderStatic`.

Request: add these to `@tejika/cli`, next to `withLogLevel`, `withPort` and `withSocketPath`.

## UI components

Two small Ink components in `@mokei/cli` belong with the existing `@tejika/ui` cards:

- `ExitOnAbort` -- exits the Ink app when a signal aborts.
- `InterruptOnCtrlC` -- calls a handler on Ctrl+C instead of exiting at once.

Later candidate: a schema-driven form card, generalised from the mokei elicitation form.

## Daemon command group

`mokei daemon start|stop|status|restart|logs` is generic over the app name. It wraps
`@tejika/process` and has these parts:

- A start that reports a socket mismatch when another build owns the socket.
- Stop and restart with a bounded wait (signal plus deadline).
- `logs --follow`, which tails the daemon log file.

Request: a `createDaemonCommand({ app, entry, ... })` in `@tejika/cli`. The log tail could be a
`followLog` export in `@tejika/log`. Fix this mokei bug as part of the move: its daemon commands
ignore a custom `--pid-path`.
