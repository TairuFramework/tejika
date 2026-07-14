# @tejika/process

Local daemon spawn / lifecycle / Enkaku client reconnect for CLIs built on the
`@tejika/*` stack.

- `runDaemon` — boot a daemon in the current process. Takes a short-lived boot
  mutex (`@sozai/lock`, at `<pidPath>.lock`) before classifying, cleaning up and
  binding its socket (no split-brain boot race), writes its presence record, and
  returns a `DaemonHandle`.
- `ensureDaemon` — connect to a running daemon, spawning and waiting for one if
  none is reachable, under a single time budget.
- `stopDaemon` — signal a running daemon, wait for it to exit (escalating to
  `SIGKILL`), and report what happened instead of throwing.
- `getDaemonStatus` — classify a daemon's state file into a `state` union, purely
  and lock-free (never mutates the filesystem, never blocks behind a boot).
- `createDaemonClient` / `createDaemonTransport` — connect an Enkaku client to
  a daemon socket, reconnecting automatically on drop.
- `spawnDaemon` — spawn the detached daemon process and wait for its socket,
  surfacing a boot crash as a `DaemonBootError` instead of a bare timeout.

## Examples

### `runDaemon`

The daemon entry `ensureDaemon`/`spawnDaemon` spawns must parse `--socket-path`
and `--pid-path` from `argv` and pass them through — see "always passed to the
child" below for why.

```ts
import { parseArgs } from 'node:util'
import { runDaemon } from '@tejika/process'
import { serve } from '@enkaku/server'
import type { MyProtocol } from './protocol.js'

const { values } = parseArgs({
  options: { 'socket-path': { type: 'string' }, 'pid-path': { type: 'string' } },
  strict: false,
})

const handle = await runDaemon<MyProtocol>({
  app: 'my-app',
  socketPath: values['socket-path'] as string,
  pidPath: values['pid-path'] as string,
  serve: (transport) =>
    serve<MyProtocol>({ requireAuth: false, handlers: { ping: () => 'pong' }, transport }),
})

// handle.pid, handle.socketPath, handle.pidPath
await handle.close() // idempotent
```

### `ensureDaemon`

```ts
import { ensureDaemon } from '@tejika/process'
import type { MyProtocol } from './protocol.js'

const client = await ensureDaemon<MyProtocol>({
  app: 'my-app',
  entry: new URL('./daemon-entry.js', import.meta.url).pathname,
})

await client.request('ping') // 'pong'
await client.dispose()
```

### `stopDaemon`

```ts
import { stopDaemon } from '@tejika/process'

const result = await stopDaemon({ app: 'my-app' })
if (!result.stopped) {
  // 'not-running' | 'not-owned' | 'timeout' | 'aborted' | 'busy' | 'error'
  console.log(result.reason)
}
```

`stopDaemon` never throws — every outcome, including an unexpected errno from the
kill itself (`reason: 'error'`, with the failure on `result.error`), comes back as
a `StopResult`.

## Breaking changes

This package's public surface changed substantially on top of the last
published `0.1.0`. If you're upgrading, read this section first.

**Stop any running daemon before upgrading.** The pidfile format changed (see
below); a daemon booted by the old code is invisible to the new
`getDaemonStatus`/`ensureDaemon`, which leads to a confusing (if harmless)
`DaemonAlreadyRunningError` on the next boot attempt instead of a clean
takeover.

| Before | After |
|---|---|
| `@tejika/env`'s `getPidPath` | `getPIDPath` — hard rename, no alias |
| `getDaemonStatus(): DaemonStatus`, synchronous, reaped a stale pidfile as a side effect | `getDaemonStatus(): Promise<DaemonStatus>`, pure — never reaps |
| `DaemonStatus = { running: boolean; pid?: number; stale: boolean }` | discriminated union on `state`: `'not-running' \| 'stale' \| 'booting' \| 'running' \| 'running-not-owned'` — there is no `.running` boolean anymore |
| `stopDaemon(): Promise<void>` — fire-and-forget `SIGTERM`, could throw | `stopDaemon(): Promise<StopResult>` (`{ stopped, pid?, reason?, error? }`) — waits for exit and escalates to `SIGKILL` by default, reporting failure rather than throwing. Never throws, not even on your own `signal` firing: an abort mid-stop resolves with `reason: 'aborted'` (`reason` is `'not-running' \| 'not-owned' \| 'timeout' \| 'aborted' \| 'error'`) rather than rejecting, because the daemon's fate is genuinely unknown at that point and reporting a timeout would be a lie. An already-aborted `signal` is refused up-front, so no `SIGTERM` is ever sent |
| `runDaemon(): Promise<void>`, signal handlers always installed | `runDaemon(): Promise<DaemonHandle>` (`{ pid, socketPath, pidPath, close() }`); still `await`-compatible at the call site. Signal handlers are opt-in via `handleSignals` (default `true`) |
| `spawnDaemon`'s post-spawn wait just timed out on a boot crash | `spawnDaemon` races the child's exit against the socket wait and throws a `DaemonBootError` (carrying `logPath`) immediately on a crash |
| `ensureDaemon({ timeoutMs })` bounded only the post-spawn connect retries (default 5000ms) | `timeoutMs` bounds the whole call — connect, spawn, socket wait, retries (default 10000ms). It bounds only the call: neither the timeout nor your `signal` is wired into the returned client, whose reconnect loop keeps your unclamped `connectTimeoutMs` and outlives the budget |
| `spawnDaemon` passed `--pid-path` only when you supplied `pidPath` | `pidPath` defaults from `app` (like `socketPath`) and is always passed to the child. An entry that parses and honors the flag can never resolve a different lockfile than its parent; an entry that ignores it (e.g. re-deriving paths from `app` alone) can still diverge under an `env` override — see the `runDaemon` example above |

New exports with no `0.1.0` equivalent: `createDaemonTransport` (the
reconnecting-transport seam behind `createDaemonClient`, for a consumer with
its own `Client` subtype), `createDeadline`/`Deadline` (a composable
signal+timeout budget), `probeSocket`, and typed errors
`DaemonAlreadyRunningError` / `DaemonBootError`.

`probeSocket` returns `'live' | 'dead' | 'forbidden' | 'unknown'`. Only
`'dead'` is load-bearing, and only `'dead'` is dangerous: it is the verdict
that authorises unlinking a socket file. So it is stated positively —
`ECONNREFUSED`, `ENOENT`, `ENOTSOCK` — and everything else fails safe.
`'forbidden'` (`EACCES`/`EPERM`) means another user's daemon is listening;
`'unknown'` means the connect failed for a reason that says nothing about the
peer (`EMFILE`, `ENOMEM`, …, i.e. *our* problem, not the daemon's). `isSocketLive`
is true for all three non-dead verdicts, so a machine under fd pressure can
never unlink a healthy daemon's socket.

**Locking moved out of the pidfile (0.3.0).** The pidfile is still JSON at the
same path, with the same fields — it is now a `DaemonState`
(`{ pid, socketPath, startedAt, ready }`), a *presence record* and nothing more.
Exclusion is a separate, short-lived mutex at `<pidPath>.lock`, provided by
[`@sozai/lock`](https://www.npmjs.com/package/@sozai/lock) and held only across
the boot, stop and shutdown critical sections — never for the daemon's lifetime,
so `getDaemonStatus` never blocks behind a live daemon.

| Before | After |
|---|---|
| `LockRecord` | `DaemonState` — same fields, exported as a type |
| `runDaemon({ bootGraceMs })`, `getDaemonStatus({ bootGraceMs })` | gone. An unready record is `'booting'` to an observer, and provably abandoned to a mutex holder — no clock is consulted |
| — | `runDaemon({ lockPath, lockTimeoutMs })` and `stopDaemon({ lockPath, lockTimeoutMs })`. `lockPath` defaults to `` `${pidPath}.lock` ``, so nothing needs configuring, and no new CLI flag is passed to the child |
| — | `StopResult.reason: 'busy'` — the mutex is held by a concurrent boot or stop, so nothing was attempted |
| — | `TimeoutInterruption` (re-exported from `@sozai/lock`) can escape `runDaemon` when the boot mutex cannot be taken within `lockTimeoutMs`. Distinct from `DaemonAlreadyRunningError`: "someone is booting or stopping and will not let go" is not "someone is already serving" |

Why: the old pidfile was a mutex and a presence record at once, so every boot and
every stop was a check-then-act guarded by the lockfile's inode. That guard does
not hold — the kernel recycles an inode number the moment a file is unlinked, so
a reaper could unlink the very lock a fresh daemon had just claimed on the
recycled inode. `@sozai/lock` guards on a per-claim nonce, plus an OS boot ID so
a pid is only trusted when it comes from this boot.

`'booting'` is still a real, distinct `DaemonStatus` state (record written, socket
not yet bound) and must not be treated as `'running'`. A daemon booted by 0.2.0 is
still readable by 0.3.0 — the record format did not change — but it holds no boot
mutex, so stop it before upgrading rather than relying on the overlap.
