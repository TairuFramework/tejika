# @tejika/process

Local daemon spawn / lifecycle / Enkaku client reconnect for CLIs built on the
`@tejika/*` stack.

- `runDaemon` — boot a daemon in the current process. Claims an exclusive
  pidfile lock before binding its socket (no split-brain boot race), and
  returns a `DaemonHandle`.
- `ensureDaemon` — connect to a running daemon, spawning and waiting for one if
  none is reachable, under a single time budget.
- `stopDaemon` — signal a running daemon, wait for it to exit (escalating to
  `SIGKILL`), and report what happened instead of throwing.
- `getDaemonStatus` — classify a daemon's pidfile into a `state` union, purely
  (never mutates the filesystem).
- `createDaemonClient` / `createDaemonTransport` — connect an Enkaku client to
  a daemon socket, reconnecting automatically on drop.
- `spawnDaemon` — spawn the detached daemon process and wait for its socket,
  surfacing a boot crash as a `DaemonBootError` instead of a bare timeout.

## Examples

### `runDaemon`

```ts
import { runDaemon } from '@tejika/process'
import { serve } from '@enkaku/server'
import type { MyProtocol } from './protocol.js'

const handle = await runDaemon<MyProtocol>({
  app: 'my-app',
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
  // 'not-running' | 'not-owned' | 'timeout' | 'aborted' | 'error'
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
| `spawnDaemon` passed `--pid-path` only when you supplied `pidPath` | `pidPath` defaults from `app` (like `socketPath`) and is always passed to the child, so parent and child can never resolve a different lockfile |

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

**Pidfile format change.** The pidfile used to be a bare PID integer; it is
now a JSON `LockRecord` (`{ pid, socketPath, startedAt, ready }`), claimed
*before* the socket is bound — that ordering is what closes the old
split-brain boot race. The claim writes the record to a temp file and `link()`s
it into place: like `O_EXCL` it fails with `EEXIST` when the name is taken, but
unlike a create-then-write it never leaves an empty lockfile visible to a
concurrent booter (who would parse nothing, conclude "not running", and reap the
winner's fresh lock). One consequence: a lock record on disk is not proof of
readiness. `'booting'` is a real, distinct `DaemonStatus` state (claimed, not yet
listening) that must not be treated as `'running'`.

A pidfile written by the old code parses as `null` (not a conforming
`LockRecord`) to the new `getDaemonStatus`, which classifies it as
`'not-running'` — so a still-running old-format daemon is reported absent.
