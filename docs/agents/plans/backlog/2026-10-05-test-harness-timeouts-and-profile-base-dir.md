# test -- spawned CLI with timeout and live output, profile base directory

**Status:** open -- requested by mokei (flow daemon end-to-end suites)
**Package:** `@tejika/test`
**Origin:** mokei review of its integration test support code

## Why mokei does not use `@tejika/test` today

The mokei flow daemon and CLI suites reimplement `runCLI`, `createTestProfile` and the daemon
wait loops. Each one is missing a small option.

## Requested changes

### Spawned CLI with timeout and live output

Mokei needs to:

- Read stdout and stderr while the process runs, to wait for a line before it sends input or a
  signal.
- Fail with a timeout error that includes the output collected so far. Today a test that hangs
  gives no clue where it stopped.
- Kill the child with `SIGKILL` when the timeout fires.

`runCLI` accepts a `signal`, but an aborted run resolves like a spawn failure, with no timeout
message or output context. Request: a `spawnCLI(args, options)` that returns
`{ child, stdout(), stderr(), done }`, and a `timeoutMs` option on both `spawnCLI` and `runCLI`.

### `baseDir` on `createTestProfile`

The profile directory is built on `tmpdir()`. On macOS that path is long enough that a daemon unix
socket inside it goes over the `sun_path` limit, so mokei creates its profiles with
`mkdtemp('/tmp/...')` instead. Request: a `baseDir` option, or a short-path default on darwin.

### Generic wait helper

Mokei's two daemon test drivers each have a polling loop for "wait until the snapshot matches".
`poll` likely covers it once the two changes above land. Confirm, and document it next to the
daemon helpers.
