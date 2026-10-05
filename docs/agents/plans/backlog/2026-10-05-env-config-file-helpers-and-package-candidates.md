# env -- config file helpers, and new package candidates

**Status:** open -- requested by mokei (flow daemon config and storage)
**Packages:** `@tejika/env`, and two possible new packages
**Origin:** mokei review of the flow daemon Node packages

## `@tejika/env` config file helpers

Two mokei loaders repeat the same steps: the flow daemon `flows.json` loader and the OAuth file
store.

- `expandHome(path)` -- expands `~` and `~/...` to the home directory.
- `readJSONFile(path, { default })` -- reads and parses a JSON file. It returns the default on
  `ENOENT`, and it throws an error that names the path for any other read or parse failure.

Schema validation stays with the caller.

## Candidates for new packages, needs a decision

Two pieces of the mokei flow daemon are local Node plumbing with no tejika home. Do not create
either package until a second consumer exists and the owner approves it.

### sqlite helpers (for example `@tejika/sqlite`)

- Open a `node:sqlite` database: create the parent directory, then set WAL, `busy_timeout` and
  `foreign_keys`.
- Run `user_version` migrations from an ordered list, inside one transaction.
- A `withTransaction(db, fn)` helper for `BEGIN IMMEDIATE`, `COMMIT` and `ROLLBACK`.

### Node OpenTelemetry setup (`@tejika/log` or a new package)

- Detect whether a global tracer provider is already registered.
- Register an `AsyncLocalStorage` context manager.
- Shut the provider down with a timeout.
- Configure the LogTape file sink, and roll it back when setup fails part way.
