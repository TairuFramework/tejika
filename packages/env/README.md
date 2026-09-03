# @tejika/env

Local paths, ports and env-var overrides for CLI tools and daemons built on the
`@tejika/*` stack. Every path and port is namespaced by an `app` string, and
every value can be overridden through an `<APP>_<KEY>` environment variable.

```sh
pnpm add @tejika/env
```

- `getSocketPath` / `getPIDPath` / `getLockPath` — an app's IPC endpoint,
  pidfile and boot-lock path. `getSocketPath` returns a `.sock` path on POSIX
  and a `\\.\pipe\…` named pipe on win32.
- `getDataDir` / `getStateDir` / `getLogDir` — per-app XDG-style directories.
- `getPort` / `resolvePort` / `parsePort` — resolve a port for an app, honouring
  the `<APP>_PORT` override.
- `appEnvVar` / `getAppEnvVar` — build and read an `<APP>_<KEY>` variable name.
- `isNamedPipe` — test whether a socket path is a win32 named pipe.

```ts
import { getSocketPath, getPort } from '@tejika/env'

const socket = getSocketPath('myapp') // <platform data dir>/myapp/myapp.sock, e.g. ~/.local/share/myapp/myapp.sock on Linux
const port = await getPort('myapp') // honours MYAPP_PORT, else a free port
```

Overrides are read from the environment at call time, so
`MYAPP_SOCKET_PATH=/tmp/dev.sock` redirects the endpoint above without any code
change.
