# @tejika/test

## 0.4.2

### Patch Changes

- Add `spawnCLI(args, options)`, returning `{ child, stdout(), stderr(), done }` so a test can
  read output while the child runs. `spawnCLI` and `runCLI` take a `timeoutMs` option: on timeout
  the child is killed with `SIGKILL` and the promise rejects with a `CLITimeoutError` that includes
  the stdout and stderr collected so far. `createTestProfile` takes a `baseDir` option and defaults
  to `/tmp` on darwin, keeping daemon unix sockets under the `sun_path` limit.

## 0.4.1

### Patch Changes

- Add package metadata (description, keywords, repository) to the published manifest

- Updated dependencies:
  - @tejika/env@0.5.0
  - @tejika/process@0.5.0
