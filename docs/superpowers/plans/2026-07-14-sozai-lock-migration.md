# `@sozai/lock` Daemon Locking Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `@tejika/process`'s hand-rolled daemon lockfile with a short-lived `@sozai/lock` mutex around the boot, stop, and close critical sections, moving daemon presence into a separate state file.

**Architecture:** `@sozai/lock` becomes a boot/stop/close mutex at `${pidPath}.lock`. Daemon presence stays at `pidPath`, as a JSON `DaemonState` record that tejika reads and writes itself (`state.ts`). Every check-then-act race — the `link()` claim, the inode-guarded reaps, the temp-record sweep, the three-attempt retry loop, the ten-second boot grace — collapses into "hold the mutex", and `lock.ts` is deleted.

**Tech Stack:** TypeScript (NodeNext, ES2025), Node 24/26, Vitest, Biome, pnpm workspaces with a catalog, `@sozai/lock@^0.1.0` (published range, not `workspace:`).

**Design spec:** `docs/superpowers/specs/2026-07-14-sozai-lock-migration-design.md`. Read it before starting.

## Global Constraints

- No `interface` — use `type`. No `T[]` — use `Array<T>`. No `any` — use `unknown` or a specific type.
- Capitalised abbreviations in names: `ID`, `HTTP`, `PID` (`getPIDPath`, not `getPidPath`).
- ES private fields (`#field`) + getters, never the TS `private`/`readonly` modifiers.
- `pnpm` / `pnpx` only, never `npm` / `npx`. Never edit `lib/` (generated).
- Lint with `pnpm exec biome check --write ./packages` (an `rtk` shim hijacks `pnpm run lint`).
- Run a package's tests with `pnpm --filter @tejika/process exec vitest run <file>`; the whole repo with `pnpm exec turbo run test`.
- Never write a workaround for a bug in `@enkaku/*` or `@sozai/*` — fix it at the source repo.
- The pidfile keeps its name, its path, its `<APP>_PID_PATH` env override, its `.pid` extension, and its JSON contents. `--pid-path`, `RunDaemonOptions.pidPath` and `@tejika/test`'s `waitForDaemonRunning({ pidPath })` are untouched.
- No new environment variable, and no new CLI flag: `lockPath` defaults to `` `${pidPath}.lock` `` in both parent and child.
- The `pid > 0` validation and its security comment survive the migration verbatim (see Task 2). A non-positive pid is not a daemon, it is a weapon.

## Deviations from the spec (deliberate, both already amended into the spec)

1. **`close()` uses a try-lock (`timeout: 0`), not a waiting acquire.** A waiting acquire deadlocks against `stopDaemon`, which holds the mutex for the whole SIGTERM-and-poll while waiting for that very process to exit: every stop would wait out `killTimeoutMs` and then SIGKILL a daemon whose `onShutdown` never finished. Task 6 has the regression test.
2. **`try` / `finally` + `lock.release()` rather than `using`.** Semantically identical, zero dependency on downlevel `using` support in swc and vitest, and it matches the existing style in `daemon.ts`.
3. **No changeset.** This repo has no changesets setup; versions are bumped by hand in `package.json` (see commit `119bc71`). Task 7 does that.

## File Structure

```
packages/env/src/paths.ts            MODIFY   + getLockPath
packages/env/src/index.ts            MODIFY   + export getLockPath
packages/env/test/paths.test.ts      MODIFY   + getLockPath tests

packages/process/src/state.ts        CREATE   DaemonState + read/write/remove. No claiming, no reaping.
packages/process/src/stop.ts         CREATE   stopDaemon + signalTolerantly + pollUntilGone, under the mutex
packages/process/src/status.ts       SHRINK   classifyState + getDaemonStatus only
packages/process/src/daemon.ts       MODIFY   boot + close under the mutex
packages/process/src/spawn.ts        MODIFY   readDaemonState / classifyState
packages/process/src/index.ts        MODIFY   public API
packages/process/src/lock.ts         DELETE

packages/process/test/state.test.ts        CREATE
packages/process/test/stop.test.ts         CREATE   (stopDaemon tests move out of status.test.ts)
packages/process/test/mutex.test.ts        CREATE   the properties the mutex makes provable
packages/process/test/lock-record.test.ts  CREATE   pins the @sozai/lock semantics we depend on
packages/process/test/status.test.ts       SHRINK
packages/process/test/daemon.test.ts       MODIFY
packages/process/test/spawn.test.ts        MODIFY   import path only
packages/process/test/fixtures/stop-nonpositive-pid.ts  MODIFY  import path only
packages/process/test/lock.test.ts         DELETE
```

---

### Task 1: `getLockPath` in `@tejika/env`

**Files:**
- Modify: `packages/env/src/paths.ts`
- Modify: `packages/env/src/index.ts`
- Test: `packages/env/test/paths.test.ts`

**Interfaces:**
- Consumes: `getPIDPath(app: string): string` (existing).
- Produces: `getLockPath(app: string): string` — the boot mutex path, always `` `${getPIDPath(app)}.lock` ``. Derived, never separately configured: a second env override would reintroduce the parent/child path-divergence hazard documented at `spawn.ts:68`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/env/test/paths.test.ts`, after the `getPIDPath` describe block:

```ts
describe('getLockPath', () => {
  test('derives the lock path from the pid path', () => {
    expect(getLockPath('myapp')).toBe(`${getPIDPath('myapp')}.lock`)
  })

  // Derived, never separately configured: one override moves both, so a parent and
  // its spawned child can never resolve different mutexes.
  test('follows the pid path override', () => {
    process.env.MYAPP_PID_PATH = '/tmp/custom.pid'
    expect(getLockPath('myapp')).toBe('/tmp/custom.pid.lock')
  })
})
```

Update the import at the top of the file:

```ts
import { getDataDir, getLockPath, getPIDPath, getSocketPath, getStateDir } from '../src/paths.js'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tejika/env exec vitest run test/paths.test.ts`
Expected: FAIL — `getLockPath is not a function` / a TS resolution error on the import.

- [ ] **Step 3: Implement**

Append to `packages/env/src/paths.ts`:

```ts
/**
 * The daemon boot mutex, beside the pidfile. Derived rather than separately
 * configurable on purpose: a `LOCK_PATH` override could resolve differently in a
 * spawned child than in its parent (see the `--pid-path` note in `@tejika/process`'s
 * `spawnDaemon`), and two processes on different mutexes is exactly the split brain
 * the mutex exists to prevent.
 */
export function getLockPath(app: string): string {
  return `${getPIDPath(app)}.lock`
}
```

Update `packages/env/src/index.ts`:

```ts
export { appEnvVar, getAppEnvVar } from './env-var.js'
export { getDataDir, getLockPath, getPIDPath, getSocketPath, getStateDir } from './paths.js'
export { type GetPortOptions, getPort, parsePort, resolvePort } from './ports.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tejika/env exec vitest run test/paths.test.ts`
Expected: PASS, including the pre-existing `getPIDPath` cases.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write ./packages
git add packages/env
git commit -m "feat(env): add getLockPath, derived from the pid path"
```

---

### Task 2: `state.ts` — the daemon presence record

**Files:**
- Create: `packages/process/src/state.ts`
- Test: `packages/process/test/state.test.ts`

Nothing consumes this yet — `lock.ts` stays in place and `daemon.ts` keeps using it until Task 5. The on-disk format is byte-identical to today's `LockRecord`, so the two coexist over the same file without conflict.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type DaemonState = { pid: number; socketPath: string; startedAt: number; ready: boolean }`
  - `readDaemonState(path: string): DaemonState | null` — null for absent, unreadable, corrupt, or non-conforming.
  - `writeDaemonState(path: string, state: DaemonState): void` — atomic (temp file + `rename`).
  - `removeDaemonState(path: string): void` — unconditional, tolerates absence.

- [ ] **Step 1: Write the failing tests**

Create `packages/process/test/state.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type DaemonState, readDaemonState, removeDaemonState, writeDaemonState } from '../src/state.js'

let dir: string
let pidPath: string

// Runs on a real second thread: spin on the state file and count every moment it
// exists but does not parse. An absent file (between cycles) is fine and skipped.
const READER_SOURCE = `
const { readFileSync } = require('node:fs')
const { parentPort, workerData } = require('node:worker_threads')
const flag = new Int32Array(workerData.stop)
let bad = 0
let seen = 0
while (Atomics.load(flag, 0) === 0) {
  let raw
  try {
    raw = readFileSync(workerData.pidPath, 'utf8')
  } catch {
    continue
  }
  seen++
  try {
    if (typeof JSON.parse(raw).pid !== 'number') bad++
  } catch {
    bad++
  }
}
parentPort.postMessage({ bad, seen })
`

const state = (over: Partial<DaemonState> = {}): DaemonState => ({
  pid: 1234,
  socketPath: '/tmp/app.sock',
  startedAt: 1_700_000_000_000,
  ready: false,
  ...over,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-state-'))
  pidPath = join(dir, 'app.pid')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeDaemonState', () => {
  test('round-trips a record', () => {
    writeDaemonState(pidPath, state())
    expect(readDaemonState(pidPath)).toEqual(state())
  })

  test('replaces an existing record', () => {
    writeDaemonState(pidPath, state())
    writeDaemonState(pidPath, state({ ready: true }))
    expect(readDaemonState(pidPath)?.ready).toBe(true)
  })

  test('leaves no temp file behind', () => {
    writeDaemonState(pidPath, state())
    expect(existsSync(`${pidPath}.tmp`)).toBe(false)
  })

  // `getDaemonStatus` is a LOCK-FREE reader, so the write must be atomic to it even
  // though only a mutex holder ever writes. A create-then-write leaves an empty file
  // visible for microseconds; a reader that lands there parses nothing and concludes
  // "not running" about a live daemon. A real second thread hammers the path while
  // this one writes, so the window is genuinely observed rather than argued about.
  test('a concurrent reader never observes an empty or half-written record', {
    timeout: 20_000,
  }, async () => {
    const stop = new SharedArrayBuffer(4)
    const flag = new Int32Array(stop)
    const reader = new Worker(READER_SOURCE, { eval: true, workerData: { pidPath, stop } })
    const observed = new Promise<{ bad: number; seen: number }>((resolve) => {
      reader.once('message', resolve)
    })
    await new Promise<void>((resolve) => reader.once('online', () => resolve()))

    let cycles = 0
    const until = Date.now() + 750
    while (Date.now() < until) {
      writeDaemonState(pidPath, state({ pid: process.pid }))
      writeDaemonState(pidPath, state({ pid: process.pid, ready: true }))
      cycles++
    }
    Atomics.store(flag, 0, 1)

    const { bad, seen } = await observed
    await reader.terminate()

    expect(cycles).toBeGreaterThan(100)
    expect(seen).toBeGreaterThan(0)
    expect(bad).toBe(0)
  })
})

describe('readDaemonState', () => {
  test('returns null when the file is absent', () => {
    expect(readDaemonState(join(dir, 'absent.pid'))).toBeNull()
  })

  test('returns null for a corrupt file', () => {
    writeFileSync(pidPath, 'garbage', 'utf8')
    expect(readDaemonState(pidPath)).toBeNull()
  })

  test('returns null for a record missing required fields', () => {
    writeFileSync(pidPath, JSON.stringify({ pid: 5 }), 'utf8')
    expect(readDaemonState(pidPath)).toBeNull()
  })

  test('returns null for a record with a non-numeric pid', () => {
    writeFileSync(pidPath, JSON.stringify({ ...state(), pid: 'abc' }), 'utf8')
    expect(readDaemonState(pidPath)).toBeNull()
  })

  // A non-positive pid is not a daemon, it is a weapon. `process.kill(0, sig)` signals
  // the WHOLE process group — the CLI that read this file included — and `kill(-1, sig)`
  // every process the user may signal. Both also pass a liveness check (`kill(pid, 0)`
  // succeeds), so such a record classifies as a LIVE daemon and walks straight into
  // `stopDaemon`'s SIGTERM.
  test.each([0, -1, -12345])('returns null for a record with a pid of %i', (pid) => {
    writeFileSync(pidPath, JSON.stringify({ ...state(), pid }), 'utf8')
    expect(readDaemonState(pidPath)).toBeNull()
  })
})

describe('removeDaemonState', () => {
  test('removes the record', () => {
    writeDaemonState(pidPath, state())
    removeDaemonState(pidPath)
    expect(existsSync(pidPath)).toBe(false)
  })

  test('tolerates an already-removed record', () => {
    expect(() => removeDaemonState(pidPath)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tejika/process exec vitest run test/state.test.ts`
Expected: FAIL — cannot resolve `../src/state.js`.

- [ ] **Step 3: Implement**

Create `packages/process/src/state.ts`:

```ts
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * The daemon's presence record — NOT a lock. Exclusion is the boot mutex's job
 * (`@sozai/lock`, at `${pidPath}.lock`); this file only says who is serving, where, and
 * whether it has finished binding. `ready` is false between claiming the state file and
 * binding the socket: an observer must be able to tell "booting" from "crashed after
 * claiming", and only the record can carry that distinction.
 */
export type DaemonState = {
  pid: number
  socketPath: string
  startedAt: number
  ready: boolean
}

function isDaemonState(value: unknown): value is DaemonState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return (
    typeof state.pid === 'number' &&
    Number.isInteger(state.pid) &&
    // A non-positive pid is not a daemon, it is a weapon: `process.kill(0, sig)`
    // signals the WHOLE process group — the CLI reading this file included — and
    // `kill(-1, sig)` every process the user may signal. Worse, `kill(0, 0)`
    // succeeds, so such a record classifies as a LIVE daemon and walks straight
    // into `stopDaemon`'s SIGTERM. Refuse it here, where every reader passes:
    // a record that cannot be trusted is treated exactly like a corrupt one.
    state.pid > 0 &&
    typeof state.socketPath === 'string' &&
    typeof state.startedAt === 'number' &&
    typeof state.ready === 'boolean'
  )
}

/**
 * Read the record, or null when the file is absent, unreadable, or does not hold a
 * conforming record. Callers treat a corrupt record exactly as they treat a missing
 * one: stale. Lock-free by design — `getDaemonStatus` must never block behind a boot.
 */
export function readDaemonState(path: string): DaemonState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isDaemonState(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Write the record atomically: the content exists in full under a throwaway name before
 * `rename` gives it the name a reader looks up, so a lock-free reader sees the old record
 * or the new one, never an empty or half-written file.
 *
 * The temp name is fixed rather than random because only a mutex holder ever writes here,
 * so two writers cannot collide over it — which is what lets the old crash-orphaned temp
 * sweep go away entirely.
 */
export function writeDaemonState(path: string, state: DaemonState): void {
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, JSON.stringify(state), { encoding: 'utf8', flag: 'w', mode: 0o600 })
  try {
    renameSync(tmpPath, path)
  } catch (err) {
    rmSync(tmpPath, { force: true })
    throw err
  }
}

/**
 * Remove the record, unconditionally. Safe ONLY because every removal happens under the
 * boot mutex, or behind a pid guard when the mutex could not be taken instantly — see
 * `daemon.ts`'s `cleanUp`. Without one of those, this is an unlink of whatever happens to
 * sit at the path right now, which may be a live daemon's fresh record.
 */
export function removeDaemonState(path: string): void {
  rmSync(path, { force: true })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tejika/process exec vitest run test/state.test.ts`
Expected: PASS (13 tests — the three `test.each` pid cases count separately).

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write ./packages
git add packages/process/src/state.ts packages/process/test/state.test.ts
git commit -m "feat(process): add the daemon state record, split from the lock"
```

---

### Task 3: Take the `@sozai/lock` dependency

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `packages/process/package.json`
- Test: `packages/process/test/lock-record.test.ts` (create)

The test is not a test of somebody else's library for its own sake: it pins the three `@sozai/lock` behaviours the rest of this migration is built on (a try-lock throws `TimeoutInterruption` under contention; a released lock is immediately re-acquirable; a lock whose holder is dead is reaped rather than waited out). If any of them ever changes upstream, this fails here rather than as a mystery deadlock in `close()`.

**Interfaces:**
- Consumes: `@sozai/lock@^0.1.0` — `acquireFileLock(path, { timeout, staleTimeout, signal }): Promise<FileLock>`, `withFileLock(path, fn, options): Promise<T>`, `FileLock = Disposable & { readonly path: string; release(): void }`, `TimeoutInterruption`.
- Produces: nothing new in tejika's own API.

- [ ] **Step 1: Add the dependency**

In `pnpm-workspace.yaml`, add to the `catalog:` block, keeping it alphabetical (after `@inkjs/ui`, before `@types/node`):

```yaml
  '@sozai/lock': ^0.1.0
```

`@sozai/*` is already in `minimumReleaseAgeExclude`, so no change is needed there.

In `packages/process/package.json`, add to `dependencies`, keeping it alphabetical (after `@enkaku/socket`, before `@tejika/env`):

```json
    "@sozai/lock": "catalog:",
```

A published `^` range via the catalog, NOT `workspace:` — sozai lives in a separate repo and its downstream consumers take it from the registry.

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: `@sozai/lock` and its transitive `@sozai/async` appear in `pnpm-lock.yaml`; the install exits 0.

- [ ] **Step 3: Write the test**

Create `packages/process/test/lock-record.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireFileLock, TimeoutInterruption } from '@sozai/lock'
import { afterEach, beforeEach, expect, test } from 'vitest'

let dir: string
let lockPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-sozai-'))
  lockPath = join(dir, 'app.pid.lock')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// `close()` takes the mutex with `timeout: 0` precisely because it must never wait —
// a waiting acquire there deadlocks against a `stopDaemon` that is holding the mutex
// while waiting for this process to exit. This pins the semantics that makes it safe:
// a try-lock under contention FAILS FAST, and it fails with a distinguishable error.
test('a try-lock throws TimeoutInterruption rather than waiting', async () => {
  const held = await acquireFileLock(lockPath, { timeout: 0 })
  try {
    const started = Date.now()
    await expect(acquireFileLock(lockPath, { timeout: 0 })).rejects.toBeInstanceOf(
      TimeoutInterruption,
    )
    expect(Date.now() - started).toBeLessThan(500)
  } finally {
    held.release()
  }
})

test('a released lock is immediately re-acquirable', async () => {
  const first = await acquireFileLock(lockPath, { timeout: 0 })
  first.release()
  const second = await acquireFileLock(lockPath, { timeout: 0 })
  expect(second.path).toBe(lockPath)
  second.release()
})

// The wedge tejika depends on NOT happening: a booter SIGKILLed mid-boot leaves its
// lockfile behind, and the next boot must reap it on the holder's death rather than
// wait out the 60s stale timeout.
test('a lock whose holder is dead is reaped, not waited out', async () => {
  // A pid far above any live process, so kill(pid, 0) yields ESRCH.
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 2 ** 22,
      hostname: 'nowhere',
      nonce: 'dead',
      bootID: null,
      bootAt: null,
      startedAt: Date.now(),
      uptimeAt: null,
    }),
    'utf8',
  )
  const started = Date.now()
  const lock = await acquireFileLock(lockPath, { timeout: 2_000 })
  expect(Date.now() - started).toBeLessThan(1_000)
  lock.release()
})
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @tejika/process exec vitest run test/lock-record.test.ts`
Expected: PASS (3 tests). A failure on the third test means the record shape above no longer matches `@sozai/lock`'s `LockRecord` — read `packages/lock/src/record.ts` in the sozai repo and fix the fixture, do NOT loosen the assertion.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write ./packages
git add pnpm-workspace.yaml pnpm-lock.yaml packages/process/package.json packages/process/test/lock-record.test.ts
git commit -m "build(process): depend on @sozai/lock"
```

---

### Task 4: `status.ts` classifies state; `stopDaemon` moves to `stop.ts`, under the mutex

**Files:**
- Modify: `packages/process/src/status.ts` (shrinks to classification)
- Create: `packages/process/src/stop.ts`
- Modify: `packages/process/src/spawn.ts`
- Modify: `packages/process/src/daemon.ts` (call sites only — the mutex arrives in Task 5)
- Modify: `packages/process/src/index.ts`
- Modify: `packages/process/test/status.test.ts` (shrinks)
- Create: `packages/process/test/stop.test.ts`
- Modify: `packages/process/test/spawn.test.ts` (import path only)
- Modify: `packages/process/test/fixtures/stop-nonpositive-pid.ts` (import path only)

After this task `daemon.ts` still claims via `lock.ts` — that is fine and compiles: `DaemonState` and `LockRecord` are the same shape over the same file. Task 5 finishes the swap.

**Interfaces:**
- Consumes: `readDaemonState`, `removeDaemonState` (Task 2); `withFileLock`, `TimeoutInterruption` (Task 3); `getPIDPath` (`@tejika/env`); `createDeadline`, `Deadline` (`./deadline.js`); `probeSocket`, `SocketProbe` (`./socket.js`).
- Produces:
  - `classifyState(state: DaemonState | null, deps?: StatusDeps): Promise<DaemonStatus>` — replaces `classifyRecord`. No `options` parameter: **no clock, no boot grace.**
  - `getDaemonStatus(opts: { app: string; pidPath?: string }): Promise<DaemonStatus>` — `bootGraceMs` is gone.
  - `DaemonStatus` — unchanged shape, still five states.
  - `StatusDeps` — unchanged.
  - `stopDaemon(opts: StopDaemonOptions): Promise<StopResult>` — now exported from `./stop.js`. `StopDaemonOptions` gains `lockPath?` and `lockTimeoutMs?`; `StopResult.reason` gains `'busy'`.
  - `signalTolerantly` — moved verbatim to `./stop.js`.
- Deleted: `classifyRecord`, `DEFAULT_BOOT_GRACE_MS`, `readStatus`, `RunDaemonOptions.bootGraceMs`, `getDaemonStatus`'s `bootGraceMs`.

- [ ] **Step 1: Rewrite `status.test.ts` (the failing test)**

Replace the whole of `packages/process/test/status.test.ts` with:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { SocketProbe } from '../src/socket.js'
import { type DaemonState, writeDaemonState } from '../src/state.js'
import { classifyState, getDaemonStatus, type StatusDeps } from '../src/status.js'

const NOW = 1_700_000_000_000

const state = (over: Partial<DaemonState> = {}): DaemonState => ({
  pid: 1234,
  socketPath: '/tmp/app.sock',
  startedAt: NOW,
  ready: true,
  ...over,
})

const errno = (code: string): NodeJS.ErrnoException => {
  const err = new Error(code) as NodeJS.ErrnoException
  err.code = code
  return err
}

const throwing = (code: string) => (): never => {
  throw errno(code)
}

const deps = (over: Partial<StatusDeps> = {}): StatusDeps => ({
  kill: () => undefined,
  probe: async (): Promise<SocketProbe> => 'live',
  ...over,
})

describe('classifyState', () => {
  test('no record means not-running', async () => {
    await expect(classifyState(null, deps())).resolves.toEqual({ state: 'not-running' })
  })

  test('ESRCH means stale', async () => {
    await expect(classifyState(state(), deps({ kill: throwing('ESRCH') }))).resolves.toEqual({
      state: 'stale',
      pid: 1234,
    })
  })

  test('EPERM means running-not-owned, never stale', async () => {
    await expect(classifyState(state(), deps({ kill: throwing('EPERM') }))).resolves.toEqual({
      state: 'running-not-owned',
      pid: 1234,
      socketPath: '/tmp/app.sock',
    })
  })

  test('a live process with a live socket is running', async () => {
    await expect(classifyState(state(), deps())).resolves.toEqual({
      state: 'running',
      pid: 1234,
      socketPath: '/tmp/app.sock',
    })
  })

  test('a forbidden socket still counts as running', async () => {
    const result = await classifyState(state(), deps({ probe: async () => 'forbidden' }))
    expect(result.state).toBe('running')
  })

  test('a live process whose socket is dead is a recycled pid: stale', async () => {
    await expect(classifyState(state(), deps({ probe: async () => 'dead' }))).resolves.toEqual({
      state: 'stale',
      pid: 1234,
    })
  })

  // `booting` is now an OBSERVER state only, and it has no clock. The old ten-second boot
  // grace decided how long an unready record stayed `booting` before it became `stale`;
  // the boot mutex decides that now, and it decides it by proof: a `ready: false` record
  // read while HOLDING the mutex was written by a process that does not hold it, so it is
  // abandoned. An observer (this function) neither holds the mutex nor needs to guess.
  test('an unready record with a live pid is booting, however old it is', async () => {
    const ancient = state({ ready: false, startedAt: NOW - 3_600_000 })
    await expect(classifyState(ancient, deps())).resolves.toEqual({
      state: 'booting',
      pid: 1234,
      socketPath: '/tmp/app.sock',
    })
  })

  test('an unready record is not probed at all — probing would race the bind', async () => {
    let probed = false
    await classifyState(
      state({ ready: false }),
      deps({
        probe: async () => {
          probed = true
          return 'dead'
        },
      }),
    )
    expect(probed).toBe(false)
  })
})

describe('getDaemonStatus', () => {
  let dir: string
  let pidPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tejika-status-'))
    pidPath = join(dir, 'app.pid')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('an absent state file is not-running', async () => {
    await expect(getDaemonStatus({ app: 'tejika-test', pidPath })).resolves.toEqual({
      state: 'not-running',
    })
  })

  test('a record naming a dead process is stale', async () => {
    // A pid far above any live process, so kill(pid, 0) yields ESRCH.
    writeDaemonState(pidPath, state({ pid: 2 ** 22, startedAt: Date.now() }))
    await expect(getDaemonStatus({ app: 'tejika-test', pidPath })).resolves.toEqual({
      state: 'stale',
      pid: 2 ** 22,
    })
  })

  // Reading must never mutate: a stale record is the boot path's to reap, under the mutex.
  test('is pure — a stale record survives being classified', async () => {
    writeDaemonState(pidPath, state({ pid: 2 ** 22, startedAt: Date.now() }))
    await getDaemonStatus({ app: 'tejika-test', pidPath })
    await expect(getDaemonStatus({ app: 'tejika-test', pidPath })).resolves.toEqual({
      state: 'stale',
      pid: 2 ** 22,
    })
  })
})
```

Two tests are deliberately gone rather than adapted, because the mutex makes the situations they cover impossible:

- *"a stop racing a boot never deletes the lockfile of the new daemon"* — a boot cannot run inside a stop's critical section any more.
- *"a daemon that marks ready mid-stop still has its lockfile reaped"* — the same; `markReady` (a rename to a new inode, mid-stop) is gone with the inode guard it defeated.

They are replaced by Task 6's `mutex.test.ts`, which asserts the stronger property directly.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tejika/process exec vitest run test/status.test.ts`
Expected: FAIL — `classifyState` is not exported from `../src/status.js`.

- [ ] **Step 3: Rewrite `status.ts`**

Replace the whole of `packages/process/src/status.ts` with:

```ts
import { getPIDPath } from '@tejika/env'
import { probeSocket, type SocketProbe } from './socket.js'
import { type DaemonState, readDaemonState } from './state.js'

export type DaemonStatus =
  | { state: 'not-running' }
  | { state: 'stale'; pid: number }
  | { state: 'booting'; pid: number; socketPath: string }
  | { state: 'running'; pid: number; socketPath: string }
  | { state: 'running-not-owned'; pid: number; socketPath: string }

/** Injected so `EPERM` and PID recycling are testable without a second user. */
export type StatusDeps = {
  kill: (pid: number, signal: 0) => void
  probe: (socketPath: string) => Promise<SocketProbe>
}

const DEFAULT_DEPS: StatusDeps = {
  kill: (pid, signal) => {
    process.kill(pid, signal)
  },
  probe: probeSocket,
}

type Liveness = 'alive' | 'dead' | 'not-owned'

function checkLiveness(pid: number, kill: StatusDeps['kill']): Liveness {
  try {
    kill(pid, 0)
    return 'alive'
  } catch (err) {
    // Only ESRCH means the process is gone. EPERM means it exists and belongs to
    // another user — treating that as dead would reap a live daemon's state file
    // and, in stopDaemon, signal an innocent process.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'not-owned' : 'dead'
  }
}

/**
 * Classify a daemon presence record. Pure, lock-free, and CLOCK-FREE: there is no boot
 * grace any more. An unready record with a live pid is `booting` however old it is —
 * deciding whether such a record is abandoned is the boot mutex's job, and the boot path
 * decides it by proof (a `ready: false` record read while holding the mutex was written by
 * a process that does not hold it) rather than by guessing at a timeout.
 */
export async function classifyState(
  state: DaemonState | null,
  deps: StatusDeps = DEFAULT_DEPS,
): Promise<DaemonStatus> {
  // A corrupt record reads as null and is indistinguishable from no record.
  if (state == null) return { state: 'not-running' }

  const liveness = checkLiveness(state.pid, deps.kill)
  if (liveness === 'dead') return { state: 'stale', pid: state.pid }
  if (liveness === 'not-owned') {
    return { state: 'running-not-owned', pid: state.pid, socketPath: state.socketPath }
  }

  if (!state.ready) {
    // Claimed but not yet bound. Probing would race the bind.
    return { state: 'booting', pid: state.pid, socketPath: state.socketPath }
  }

  if ((await deps.probe(state.socketPath)) === 'dead') {
    // The pid is alive but its socket is not. Either the pid was recycled, or the
    // daemon's socket file was unlinked out from under it. Both leave the daemon
    // unreachable by every client, so reclaiming the state file is correct.
    return { state: 'stale', pid: state.pid }
  }
  return { state: 'running', pid: state.pid, socketPath: state.socketPath }
}

/**
 * Classify the daemon's state file. Pure: never reaps, never blocks. Reaping belongs to
 * the boot and stop paths, which do it under the mutex.
 */
export async function getDaemonStatus(opts: {
  app: string
  pidPath?: string
}): Promise<DaemonStatus> {
  return await classifyState(readDaemonState(opts.pidPath ?? getPIDPath(opts.app)))
}
```

- [ ] **Step 4: Create `stop.ts`**

Create `packages/process/src/stop.ts`:

```ts
import { setTimeout as delay } from 'node:timers/promises'
import { TimeoutInterruption, withFileLock } from '@sozai/lock'
import { getPIDPath } from '@tejika/env'
import { createDeadline, type Deadline } from './deadline.js'
import { readDaemonState, removeDaemonState } from './state.js'
import { classifyState } from './status.js'

export type StopResult = {
  stopped: boolean
  pid?: number
  reason?: 'not-running' | 'not-owned' | 'timeout' | 'aborted' | 'busy' | 'error'
  /** Only with `reason: 'error'`: the failure `stopDaemon` refused to throw. */
  error?: unknown
}

export type StopDaemonOptions = {
  app: string
  pidPath?: string
  /** Boot/stop mutex path. Default `${pidPath}.lock`. */
  lockPath?: string
  /** Budget for taking the mutex. Default 10000ms. */
  lockTimeoutMs?: number
  /** Poll until the process exits, escalating to SIGKILL. Default true. */
  waitForExit?: boolean
  killTimeoutMs?: number
  signal?: AbortSignal
}

const EXIT_POLL_INTERVAL_MS = 50
const SIGKILL_GRACE_MS = 2_000
const DEFAULT_KILL_TIMEOUT_MS = 5_000
const DEFAULT_LOCK_TIMEOUT_MS = 10_000

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    // EPERM means it is still there, owned by someone else.
    return (err as NodeJS.ErrnoException).code !== 'EPERM'
  }
}

/**
 * Poll until the process exits. Budget exhausted returns false — the caller
 * escalates or reports a timeout. A CALLER abort is not a timeout: it throws the
 * original `AbortError`, which `stopDaemon` catches and turns into a
 * `reason: 'aborted'` result rather than reporting a timeout, preserving its
 * own never-throws invariant. `timedOut()` is the arbiter, so the two are told
 * apart even when the abort and the final timer land in the same tick.
 */
async function pollUntilGone(pid: number, deadline: Deadline): Promise<boolean> {
  for (;;) {
    if (isGone(pid)) return true
    if (deadline.timedOut()) return false
    try {
      await delay(Math.min(EXIT_POLL_INTERVAL_MS, deadline.remaining()), undefined, {
        signal: deadline.signal,
      })
    } catch (err) {
      if (deadline.timedOut()) return isGone(pid)
      throw err
    }
  }
}

/**
 * Send a signal, treating "already exited" as success. ESRCH between the status
 * read and the kill means the daemon exited on its own — a race we win, not an
 * error. Returns a terminal result, or null to continue.
 *
 * Never throws, because `stopDaemon` never throws: an unexpected errno becomes a
 * `reason: 'error'` result rather than a rejection. `kill` is injectable because
 * no real errno other than ESRCH/EPERM can be provoked against a valid pid.
 */
export function signalTolerantly(
  pid: number,
  signal: 'SIGTERM' | 'SIGKILL',
  kill: (pid: number, signal: string) => void = (target, sig) => {
    process.kill(target, sig)
  },
): StopResult | null {
  // Defence in depth at the authority that does the killing: `process.kill(0, sig)`
  // signals the ENTIRE process group — the CLI that called us included — and
  // `kill(-1, sig)` every process this user may signal. `isDaemonState` already
  // refuses a non-positive pid, so nothing should arrive here; if something does,
  // it is not a daemon and must not be signalled.
  if (!Number.isInteger(pid) || pid <= 0) return { stopped: false, pid, reason: 'not-running' }
  try {
    kill(pid, signal)
    return null
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return { stopped: true, pid }
    if (code === 'EPERM') return { stopped: false, pid, reason: 'not-owned' }
    return { stopped: false, pid, reason: 'error', error: err }
  }
}

/**
 * The critical section: classify, signal, wait, remove. Runs with the mutex HELD, which
 * is what lets every removal here be unconditional — no racer can write the state file
 * while we hold it, so the file we read is still the file we remove. That deletes the old
 * inode-guarded reap and its "or a rewrite of it that still names the pid we stopped"
 * fallback, both of which existed only to survive check-then-act.
 *
 * Never throws: `stopDaemon`'s contract is that it always resolves.
 */
async function stopLocked(pidPath: string, opts: StopDaemonOptions): Promise<StopResult> {
  const status = await classifyState(readDaemonState(pidPath))

  if (status.state === 'not-running') return { stopped: false, reason: 'not-running' }
  if (status.state === 'stale') {
    removeDaemonState(pidPath)
    return { stopped: false, pid: status.pid, reason: 'not-running' }
  }
  if (status.state === 'running-not-owned') {
    return { stopped: false, pid: status.pid, reason: 'not-owned' }
  }

  const pid = status.pid
  const killTimeoutMs = opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS
  try {
    const early = signalTolerantly(pid, 'SIGTERM')
    if (early != null) {
      if (early.stopped) removeDaemonState(pidPath)
      return early
    }

    if (opts.waitForExit === false) return { stopped: true, pid }

    if (await pollUntilGone(pid, createDeadline(killTimeoutMs, opts.signal))) {
      removeDaemonState(pidPath)
      return { stopped: true, pid }
    }

    const escalated = signalTolerantly(pid, 'SIGKILL')
    if (escalated != null && !escalated.stopped) return escalated
    if (await pollUntilGone(pid, createDeadline(SIGKILL_GRACE_MS, opts.signal))) {
      removeDaemonState(pidPath)
      return { stopped: true, pid }
    }
    return { stopped: false, pid, reason: 'timeout' }
  } catch (err) {
    // A CALLER abort is what normally reaches here: `pollUntilGone` resolves budget
    // exhaustion internally via `timedOut()` rather than throwing. Honor the
    // never-throws invariant by reporting it as a result instead of rejecting —
    // the daemon's fate is genuinely unknown, so 'aborted' rather than a guess.
    if ((err as { name?: string }).name === 'AbortError') {
      return { stopped: false, pid, reason: 'aborted' }
    }
    return { stopped: false, pid, reason: 'error', error: err }
  }
}

/**
 * Stop the daemon named by the state file, under the boot mutex — so a `runDaemon` racing
 * this either precedes it or waits it out, and can never bind a socket while we are
 * killing its predecessor.
 *
 * Never throws: every outcome, including the caller's own `signal` aborting mid-stop,
 * resolves as a `StopResult`. A caller abort resolves with `reason: 'aborted'` rather
 * than `reason: 'timeout'` — the daemon's fate is genuinely unknown at that point, and
 * reporting a timeout would be a lie.
 *
 * A stop can hold the mutex for `killTimeoutMs` plus the SIGKILL grace. The daemon it is
 * killing must therefore NOT block on the mutex in its own shutdown path — see `cleanUp`
 * in `daemon.ts`.
 */
export async function stopDaemon(opts: StopDaemonOptions): Promise<StopResult> {
  const pidPath = opts.pidPath ?? getPIDPath(opts.app)
  const lockPath = opts.lockPath ?? `${pidPath}.lock`

  // Refuse up-front, exactly like `runDaemon`. The signal used to be consulted
  // only inside the exit poll — i.e. after the SIGTERM had already gone out — so
  // an already-aborted caller got `reason: 'aborted'` AND a killed daemon.
  // Aborted means "do not do this", not "do it and tell me you didn't".
  if (opts.signal?.aborted === true) return { stopped: false, reason: 'aborted' }

  try {
    return await withFileLock(lockPath, () => stopLocked(pidPath, opts), {
      timeout: opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      signal: opts.signal,
    })
  } catch (err) {
    // `stopLocked` never throws, so anything here came from the ACQUIRE.
    if (err instanceof TimeoutInterruption) {
      // Someone is booting or stopping this daemon and will not let go. Not a failure of
      // the stop, and not a timeout waiting for the daemon to die: a distinct outcome.
      return { stopped: false, reason: 'busy' }
    }
    if ((err as { name?: string }).name === 'AbortError') {
      return { stopped: false, reason: 'aborted' }
    }
    // An EACCES on the lock directory, say. Still not a rejection.
    return { stopped: false, reason: 'error', error: err }
  }
}
```

- [ ] **Step 5: Update the call sites**

`packages/process/src/spawn.ts` — replace the `readLockRecord` / `classifyRecord` imports and the concession check:

```ts
import { readDaemonState } from './state.js'
import { classifyState } from './status.js'
```

(delete the `import { readLockRecord } from './lock.js'` and the `import { classifyRecord, DEFAULT_BOOT_GRACE_MS } from './status.js'` lines)

```ts
/**
 * Did SOMEONE ELSE claim the state file? Our child exiting is only a boot failure if it
 * is the whole story. Two CLIs cold-starting the same daemon is this design's
 * flagship scenario: one child wins the boot mutex and binds, the other loses it,
 * throws `DaemonAlreadyRunningError` and exits nonzero — and that exit reliably beats
 * the socket wait's first 50ms poll. Turning it into a `DaemonBootError` would fail the
 * losing CLI even though the daemon it asked for is coming up healthy under the winner.
 * So when the state file names a LIVE daemon that is not our child, the exit is a loser
 * conceding, not a crash: say nothing and let the socket wait run out its budget against
 * the winner's socket.
 */
async function anotherDaemonHoldsState(
  pidPath: string,
  childPID: number | undefined,
): Promise<boolean> {
  const state = readDaemonState(pidPath)
  if (state == null || state.pid === childPID) return false
  const status = await classifyState(state)
  // `booting` is not `running` — but it IS a live process that has claimed the state
  // file, and its socket is exactly what the wait below is waiting for.
  return status.state === 'booting' || status.state === 'running'
}
```

and in `bootFailed`:

```ts
    if (await anotherDaemonHoldsState(pidPath, childPID)) return await pending()
```

`packages/process/src/daemon.ts` — the mutex arrives in Task 5; here only the call site changes. In `claimOrThrow`, drop the `bootGraceMs` parameter and call `classifyState`:

```ts
async function claimOrThrow(pidPath: string, socketPath: string): Promise<DaemonLock> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const result = claimDaemonLock(pidPath, {
      pid: process.pid,
      socketPath,
      startedAt: Date.now(),
      ready: false,
    })
    if ('lock' in result) return result.lock

    const status = await classifyState(result.conflict)
    if (status.state !== 'stale' && status.state !== 'not-running') {
      throw new DaemonAlreadyRunningError(status.pid, socketPath)
    }
    if (result.inode != null) reapLockFile(pidPath, result.inode)
  }
  throw new DaemonAlreadyRunningError(readLockRecord(pidPath)?.pid ?? -1, socketPath)
}
```

Update its import line to `import { classifyState } from './status.js'`, delete the `bootGraceMs?: number` field from `RunDaemonOptions`, and change the call to `await claimOrThrow(pidPath, socketPath)`.

`packages/process/src/index.ts` — replace the `./status.js` export block:

```ts
export { type DaemonStatus, getDaemonStatus } from './status.js'
export { type StopDaemonOptions, type StopResult, stopDaemon } from './stop.js'
```

(`LockRecord` stays exported for now; it goes in Task 5 with `lock.ts`.)

`packages/process/test/spawn.test.ts` and `packages/process/test/fixtures/stop-nonpositive-pid.ts` — change `from '../src/status.js'` / `from '../../src/status.js'` to `'../src/stop.js'` / `'../../src/stop.js'`.

- [ ] **Step 6: Write `stop.test.ts`**

Create `packages/process/test/stop.test.ts` — the surviving `stopDaemon` tests from the old `status.test.ts`, plus the two new outcomes the mutex creates:

```ts
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { acquireFileLock } from '@sozai/lock'
import runCommand from 'nano-spawn'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { writeDaemonState } from '../src/state.js'
import { signalTolerantly, stopDaemon } from '../src/stop.js'

const APP = 'tejika-test'

const errno = (code: string): NodeJS.ErrnoException => {
  const err = new Error(code) as NodeJS.ErrnoException
  err.code = code
  return err
}

const throwing = (code: string) => (): never => {
  throw errno(code)
}

describe('stopDaemon', () => {
  let dir: string
  let pidPath: string
  let lockPath: string
  let socketPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tejika-stop-'))
    pidPath = join(dir, 'app.pid')
    lockPath = `${pidPath}.lock`
    socketPath = join(dir, 'app.sock')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('an absent state file is not-running', async () => {
    await expect(stopDaemon({ app: APP, pidPath })).resolves.toEqual({
      stopped: false,
      reason: 'not-running',
    })
  })

  // Under the mutex the removal needs no inode guard: nobody can write this file while
  // we hold the lock, so the record we classified is the record we remove.
  test('a stale state file is removed', async () => {
    const deadPID = 2 ** 22
    writeDaemonState(pidPath, { pid: deadPID, socketPath, startedAt: Date.now(), ready: true })
    await expect(stopDaemon({ app: APP, pidPath })).resolves.toEqual({
      stopped: false,
      pid: deadPID,
      reason: 'not-running',
    })
    expect(existsSync(pidPath)).toBe(false)
  })

  // A stop that cannot take the mutex has not failed and has not timed out waiting for a
  // daemon to die — someone else is booting or stopping this daemon and will not let go.
  // `stopDaemon` never throws, so `TimeoutInterruption` becomes a result.
  test('a held mutex resolves as busy, not as an error', async () => {
    const held = await acquireFileLock(lockPath, { timeout: 0 })
    try {
      writeDaemonState(pidPath, { pid: process.pid, socketPath, startedAt: Date.now(), ready: true })
      await expect(stopDaemon({ app: APP, pidPath, lockTimeoutMs: 0 })).resolves.toEqual({
        stopped: false,
        reason: 'busy',
      })
      // Busy means we did nothing at all: the record must be untouched.
      expect(existsSync(pidPath)).toBe(true)
    } finally {
      held.release()
    }
  })

  // `process.kill(0, sig)` signals the ENTIRE process group and `kill(-1, sig)` every
  // process the user may signal. `isDaemonState` refuses a non-positive pid, so such a
  // record reads as no record at all. Run detached, in its own process group, so a
  // regression kills only the child.
  test('a state file naming pid 0 is refused, not signalled to the whole process group', {
    timeout: 30_000,
  }, async () => {
    const runner = fileURLToPath(new URL('./fixtures/stop-nonpositive-pid.ts', import.meta.url))
    const result = await runCommand('node', [runner, pidPath, socketPath], {
      env: { NODE_OPTIONS: '--import tsx' },
      detached: true,
    })
    expect(JSON.parse(result.stdout)).toEqual({ stopped: false, reason: 'not-running' })
  })

  // `stopDaemon` NEVER throws. No real errno other than ESRCH/EPERM can be provoked
  // against a valid pid, hence the injected `kill`.
  test('an unexpected errno from kill becomes a result, never a rejection', () => {
    const result = signalTolerantly(1234, 'SIGTERM', throwing('EINVAL'))
    expect(result).toEqual({
      stopped: false,
      pid: 1234,
      reason: 'error',
      error: expect.objectContaining({ code: 'EINVAL' }),
    })
  })

  // The signal was only ever consulted inside the exit poll — i.e. after the kill had
  // already gone out — so an already-aborted caller got `reason: 'aborted'` AND a dead
  // daemon. `runDaemon` refuses an aborted signal up-front; so must this.
  test('an already-aborted signal prevents the SIGTERM entirely', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    try {
      await new Promise<void>((resolve) => child.once('spawn', () => resolve()))
      writeDaemonState(pidPath, {
        pid: child.pid as number,
        socketPath,
        startedAt: Date.now(),
        ready: false,
      })

      const result = await stopDaemon({ app: APP, pidPath, signal: AbortSignal.abort() })

      expect(result).toEqual({ stopped: false, reason: 'aborted' })
      // The daemon must be untouched: an aborted caller asked for nothing to happen.
      await delay(200)
      expect(() => process.kill(child.pid as number, 0)).not.toThrow()
    } finally {
      child.kill('SIGKILL')
    }
  })

  test('a caller abort resolves with reason: aborted rather than throwing or reporting a timeout', async () => {
    // A child that ignores SIGTERM, so the exit poll is still running when the caller
    // aborts. It announces itself on stdout only once the handler is installed — the
    // `spawn` event fires before the child has run a line of script.
    const child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready")'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    try {
      await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()))
      writeDaemonState(pidPath, {
        pid: child.pid as number,
        socketPath,
        startedAt: Date.now(),
        ready: false,
      })

      const controller = new AbortController()
      setTimeout(() => controller.abort(), 100)
      const started = Date.now()
      const result = await stopDaemon({
        app: APP,
        pidPath,
        killTimeoutMs: 10_000,
        signal: controller.signal,
      })

      expect(result).toEqual({ stopped: false, pid: child.pid, reason: 'aborted' })
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      child.kill('SIGKILL')
    }
  })
})
```

Note the `booting` state is what `stopDaemon` signals in the last two tests: a `ready: false` record with a live pid, which no longer needs to sit inside any boot grace to be signalled.

- [ ] **Step 7: Run the package's tests**

Run: `pnpm --filter @tejika/process exec vitest run`
Expected: PASS. `lock.test.ts` and `daemon.test.ts` still exercise the old claim path and must remain green — this task does not touch them.

Run: `pnpm --filter @tejika/process run test:types`
Expected: PASS (no `bootGraceMs`, no `classifyRecord` references left).

- [ ] **Step 8: Commit**

```bash
pnpm exec biome check --write ./packages
git add packages/process
git commit -m "refactor(process)!: classify daemon state without a clock, stop under the mutex

stopDaemon moves to stop.ts and runs its whole classify/SIGTERM/poll/remove
sequence under a @sozai/lock mutex, so every removal is unconditional. The boot
grace is gone: an unready record is 'booting' for an observer, and abandoned for
a mutex holder."
```

---

### Task 5: Boot under the mutex; delete `lock.ts`

**Files:**
- Modify: `packages/process/src/daemon.ts`
- Modify: `packages/process/src/index.ts`
- Delete: `packages/process/src/lock.ts`
- Delete: `packages/process/test/lock.test.ts`
- Modify: `packages/process/test/daemon.test.ts`

**Interfaces:**
- Consumes: `acquireFileLock`, `FileLock` (`@sozai/lock`); `readDaemonState`, `writeDaemonState`, `removeDaemonState`, `DaemonState` (`./state.js`); `classifyState` (`./status.js`); `isSocketLive`, `safeRemove` (`./socket.js`).
- Produces: `RunDaemonOptions` gains `lockPath?: string` (default `` `${pidPath}.lock` ``) and `lockTimeoutMs?: number` (default 10000). `DaemonHandle` is unchanged. `DaemonState` is re-exported from the package root; `LockRecord` is gone.
- Deleted: `lock.ts` entirely — `claimDaemonLock`, `DaemonLock`, `ClaimResult`, `LockEntry`, `LockRecord`, `readLockEntry`, `readLockRecord`, `reapLockFile`, `writeTempRecord`, `sweepTempRecords`, `TEMP_RECORD_MAX_AGE_MS`, `CLAIM_ATTEMPTS`, `claimOrThrow`.

- [ ] **Step 1: Update `daemon.test.ts` (the failing test)**

In `packages/process/test/daemon.test.ts`:

Replace the import

```ts
import { readLockRecord } from '../src/lock.js'
```

with

```ts
import { readDaemonState } from '../src/state.js'
```

and replace every `readLockRecord(` with `readDaemonState(`. Rename the first test from `'returns a handle and marks the lock ready'` to `'returns a handle and marks the state ready'`, and rename `'reclaims a stale lockfile left by a dead process'` / `'reclaims a corrupt lockfile'` to `'reclaims a stale state file left by a dead process'` / `'reclaims a corrupt state file'`.

Then replace the existing `'two concurrent boots: exactly one wins, no live socket is unlinked'` test with a three-way version — the mutex serializes any number of them, so the old two-way case is a special case of this one:

```ts
  // Deterministic now. It used to depend on an O_EXCL claim landing first, with a
  // three-attempt reap-and-retry loop behind it; now every loser simply waits for the
  // winner to release, reads a `running` record, and concedes.
  test('concurrent boots: exactly one wins, the losers concede, no live socket is unlinked', async () => {
    const results = await Promise.allSettled([boot(), boot(), boot()])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const result of results.filter((r) => r.status === 'rejected')) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(DaemonAlreadyRunningError)
    }
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
    expect(readDaemonState(pidPath)?.pid).toBe(process.pid)
    expect(readDaemonState(pidPath)?.ready).toBe(true)
  })
```

The existing `'refuses a live socket held with no lockfile, without unlinking it'` test already asserts the other new property — that a boot which fails *after* writing its `ready: false` record removes it again — via its `expect(readDaemonState(pidPath)).toBeNull()`. Keep it; it is now load-bearing, because a leaked `ready: false` record naming a live pid (ours) would read as `booting` to every observer forever.

Delete `packages/process/test/lock.test.ts`. Its worker-thread contention harness tests a mutex that `@sozai/lock` now owns and tests upstream; the reader-atomicity property it also covered moved to `state.test.ts` in Task 2.

```bash
git rm packages/process/test/lock.test.ts
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tejika/process exec vitest run test/daemon.test.ts`
Expected: FAIL on the three-way concurrent-boot test. The record format is unchanged, so `readDaemonState` reads what the old claim path writes and every other test still passes — but three simultaneous boots exhaust `CLAIM_ATTEMPTS` (3) in the old reap-and-retry loop, so a loser can fail with a `DaemonAlreadyRunningError` naming pid `-1` (the fallback throw with no record to read) or, worse, more than one can win. The mutex is what makes it deterministic.

If it happens to pass by luck, run it again with `--repeat 5`. Do not weaken it; it must pass deterministically after Step 3.

- [ ] **Step 3: Rewrite the boot section of `daemon.ts`**

Replace the import block at the top of `packages/process/src/daemon.ts`:

```ts
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { createServer, type Server as NetServer, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type {
  ClientMessage,
  ProtocolDefinition,
  ServerMessage,
  ServerTransportOf,
} from '@enkaku/protocol'
import type { Server } from '@enkaku/server'
import { SocketTransport } from '@enkaku/socket'
import { acquireFileLock, type FileLock } from '@sozai/lock'
import { getPIDPath, getSocketPath } from '@tejika/env'
import { DaemonAlreadyRunningError } from './errors.js'
import { isSocketLive, safeRemove } from './socket.js'
import {
  type DaemonState,
  readDaemonState,
  removeDaemonState,
  writeDaemonState,
} from './state.js'
import { classifyState } from './status.js'

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const DEFAULT_LOCK_TIMEOUT_MS = 10_000
```

(`CLAIM_ATTEMPTS` is gone. So is the whole `claimOrThrow` function — delete it.)

Add the two new options to `RunDaemonOptions`, after `pidPath`:

```ts
  /** Boot mutex path. Default `${pidPath}.lock`. */
  lockPath?: string
  /**
   * Budget for taking the boot mutex. Default 10000ms — a concurrent `stopDaemon` can
   * hold it for `killTimeoutMs` plus the SIGKILL grace, and waiting that out is correct.
   */
  lockTimeoutMs?: number
```

Add the shutdown helper, next to `closeServer`:

```ts
/**
 * Remove our socket and our state record, under the boot mutex when it can be taken
 * INSTANTLY.
 *
 * A try-lock, never a waiting acquire: `stopDaemon` holds the mutex for its whole
 * SIGTERM-and-poll, and what it is waiting for is this very process to exit. Blocking here
 * would make every stop wait out `killTimeoutMs` and then SIGKILL a daemon whose
 * `onShutdown` never finished.
 *
 * A failed try-lock means someone else holds the mutex, and both possibilities are safe:
 * a stopper waiting for us (it binds nothing, so our own cleanup is uncontended), or a
 * booter that found our socket closed, classified us stale, and claimed the state file —
 * whose fresh record the pid guard refuses to touch. The pid guard is what makes the
 * removal safe with or without the lock; the lock only narrows the window between reading
 * the record and acting on it.
 */
async function cleanUp(lockPath: string, pidPath: string, socketPath: string): Promise<void> {
  let lock: FileLock | null = null
  try {
    lock = await acquireFileLock(lockPath, { timeout: 0 })
  } catch {
    // Held by someone else. Fall through: the pid guard below still applies.
  }
  try {
    if (readDaemonState(pidPath)?.pid === process.pid) {
      safeRemove(socketPath)
      removeDaemonState(pidPath)
    }
  } finally {
    lock?.release()
  }
}
```

In `runDaemon`, add the lock path beside the other defaults:

```ts
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  const pidPath = opts.pidPath ?? getPIDPath(opts.app)
  const lockPath = opts.lockPath ?? `${pidPath}.lock`
```

Replace the claim and the bind block — everything from `const lock = await claimOrThrow(...)` down to `lock.markReady()` — keeping the `createServer(...)` block that sits between them exactly where it is:

```ts
  const lock = await acquireFileLock(lockPath, {
    timeout: opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    signal: opts.signal,
  })

  const connections = new Set<Socket>()
  const server = createServer((socket) => {
    // ... unchanged
  })

  // Everything from the classification through the bind runs under the boot mutex. It is
  // a BOOT mutex, not a presence record: it is released the moment the socket is bound
  // and the record says `ready`, because holding it for the daemon's lifetime would block
  // every stop and every status read behind a live daemon.
  try {
    const status = await classifyState(readDaemonState(pidPath))
    if (status.state === 'running' || status.state === 'running-not-owned') {
      throw new DaemonAlreadyRunningError(status.pid, socketPath)
    }
    // `not-running`, `stale` and `booting` are ALL free to take. `booting` is the
    // load-bearing one: a `ready: false` record is only ever written inside this section,
    // by a process holding this mutex. We hold it, so its writer does not, so it is
    // abandoned. That is a proof — and it is what replaced the old ten-second boot grace,
    // a guess that failed in both directions (too short: steal a live-but-slow booter's
    // socket, a split brain; too long: block a legitimate boot behind a corpse).

    if (existsSync(socketPath)) {
      if (await isSocketLive(socketPath)) {
        // A foreign daemon holds the socket without a state file. We hold the mutex, but
        // its socket is not ours to steal.
        throw new DaemonAlreadyRunningError(-1, socketPath)
      }
      safeRemove(socketPath)
    }

    const claimed: DaemonState = {
      pid: process.pid,
      socketPath,
      startedAt: Date.now(),
      ready: false,
    }
    writeDaemonState(pidPath, claimed)

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        chmodSync(socketPath, 0o600)
        resolve()
      })
    })

    writeDaemonState(pidPath, { ...claimed, ready: true })
  } catch (err) {
    server.close(() => {})
    // Only ever our own record: a failure BEFORE `writeDaemonState` leaves whatever stale
    // record was already on disk, which is not ours to remove — the next booter reaps it
    // under this same mutex.
    if (readDaemonState(pidPath)?.pid === process.pid) removeDaemonState(pidPath)
    throw err
  } finally {
    lock.release()
  }

  // The boot promise has settled; its `reject` would be a no-op for later errors.
  server.removeAllListeners('error')
  server.on('error', (err) => opts.onError?.(err))
```

Finally, in `close`, replace the `finally` body:

```ts
      try {
        await closeServer(server, connections)
        if (opts.onShutdown != null) await withTimeout(opts.onShutdown(), shutdownTimeoutMs)
      } finally {
        // Always: a rejected or timed-out onShutdown must not leak the socket file or the
        // state record.
        await cleanUp(lockPath, pidPath, socketPath)
      }
```

- [ ] **Step 4: Delete `lock.ts` and update `index.ts`**

```bash
git rm packages/process/src/lock.ts
```

`packages/process/src/index.ts` becomes:

```ts
export {
  type CreateDaemonClientOptions,
  createDaemonClient,
  createDaemonTransport,
  type DaemonTransport,
} from './client.js'
export { type EnsureDaemonOptions, ensureDaemon } from './controller.js'
export { type DaemonHandle, type RunDaemonOptions, runDaemon } from './daemon.js'
export { createDeadline, type Deadline } from './deadline.js'
export { DaemonAlreadyRunningError, DaemonBootError } from './errors.js'
export {
  type ConnectSocket,
  classifyConnectError,
  isSocketLive,
  probeSocket,
  type SocketProbe,
  waitForSocket,
} from './socket.js'
export { type SpawnDaemonOptions, spawnDaemon } from './spawn.js'
export type { DaemonState } from './state.js'
export { type DaemonStatus, getDaemonStatus } from './status.js'
export { type StopDaemonOptions, type StopResult, stopDaemon } from './stop.js'
// Re-exported because it can now escape `runDaemon`: a boot that cannot take the mutex
// within `lockTimeoutMs` throws it, and callers need something to catch. Deliberately
// distinct from `DaemonAlreadyRunningError` — "someone is booting or stopping and will not
// let go" is not "someone is already serving".
export { TimeoutInterruption } from '@sozai/lock'
```

- [ ] **Step 5: Run the package's tests**

Run: `pnpm --filter @tejika/process exec vitest run`
Expected: PASS — including `controller.test.ts`, whose split-brain tests boot real concurrent daemons and are the strongest regression net for this change. If any of them goes red, the mutex is wrong; do not touch those tests.

Run: `pnpm --filter @tejika/process run test:types`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm exec biome check --write ./packages
git add packages/process
git commit -m "feat(process)!: boot and stop the daemon under a @sozai/lock mutex

Deletes lock.ts: the link() claim, the inode-guarded reaps, the temp-record
sweep and the three-attempt retry loop all existed to make check-then-act safe
without a mutex. The inode reap guard was not a guard at all — the kernel
recycles an inode number the moment a file is unlinked, so a reaper could unlink
the very lock a fresh daemon had just claimed on the recycled inode. @sozai/lock
guards on a per-claim nonce instead."
```

---

### Task 6: The properties the mutex makes provable

**Files:**
- Create: `packages/process/test/mutex.test.ts`

These are new tests, not adaptations. Each one asserts something that could not be stated before: the boot mutex serializes, an abandoned record is taken with no clock involved, and a stop and a boot cannot interleave.

**Interfaces:**
- Consumes: `runDaemon` (Task 5), `stopDaemon` (Task 4), `spawnDaemon`, `readDaemonState`, `writeDaemonState`, `acquireFileLock`, `TimeoutInterruption`.
- Produces: nothing.

- [ ] **Step 1: Write the tests**

Create `packages/process/test/mutex.test.ts`:

```ts
import { spawn as spawnChild } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { serve } from '@enkaku/server'
import { acquireFileLock, TimeoutInterruption } from '@sozai/lock'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type DaemonHandle, type RunDaemonOptions, runDaemon } from '../src/daemon.js'
import { isSocketLive } from '../src/socket.js'
import { spawnDaemon } from '../src/spawn.js'
import { readDaemonState, writeDaemonState } from '../src/state.js'
import { stopDaemon } from '../src/stop.js'
import type { PingProtocol } from './fixtures/protocol.js'

const APP = 'tejika-test'
const daemonEntry = fileURLToPath(new URL('./fixtures/daemon-entry.ts', import.meta.url))
// nano-spawn merges `env` over process.env, so the child gets tsx without this process
// having to mutate its own NODE_OPTIONS.
const childEnv = { NODE_OPTIONS: '--import tsx' }

let dir: string
let socketPath: string
let pidPath: string
let lockPath: string
let logPath: string
const handles: Array<DaemonHandle> = []

const boot = async (over: Partial<RunDaemonOptions<PingProtocol>> = {}): Promise<DaemonHandle> => {
  const handle = await runDaemon<PingProtocol>({
    app: APP,
    socketPath,
    pidPath,
    handleSignals: false,
    serve: (transport) =>
      serve<PingProtocol>({ requireAuth: false, handlers: { ping: () => 'pong' }, transport }),
    ...over,
  })
  handles.push(handle)
  return handle
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-mutex-'))
  socketPath = join(dir, 'app.sock')
  pidPath = join(dir, 'app.pid')
  lockPath = `${pidPath}.lock`
  // Explicit, so the spawned daemon's log lands in the temp dir rather than the real data dir.
  logPath = join(dir, 'daemon.log')
})

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close().catch(() => {})))
  await stopDaemon({ app: APP, pidPath }).catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

// A boot that cannot take the mutex has not found a running daemon — it has found someone
// who is booting or stopping one and will not let go. Distinct from
// DaemonAlreadyRunningError, and distinct on purpose.
test('a boot that cannot take the mutex throws TimeoutInterruption and claims nothing', async () => {
  const held = await acquireFileLock(lockPath, { timeout: 0 })
  try {
    await expect(boot({ lockTimeoutMs: 100 })).rejects.toBeInstanceOf(TimeoutInterruption)
    expect(readDaemonState(pidPath)).toBeNull()
    await expect(isSocketLive(socketPath)).resolves.toBe(false)
  } finally {
    held.release()
  }
})

// The boot WAITS rather than racing. Before the mutex, a booter that found the lockfile
// held simply classified it and either threw or reaped it — there was nothing to wait on.
test('a boot blocked on the mutex proceeds as soon as it is released', async () => {
  const held = await acquireFileLock(lockPath, { timeout: 0 })
  const booting = boot({ lockTimeoutMs: 5_000 })
  let settled = false
  void booting.then(() => {
    settled = true
  })

  await delay(200)
  expect(settled).toBe(false)

  held.release()
  const handle = await booting
  expect(handle.pid).toBe(process.pid)
  await expect(isSocketLive(socketPath)).resolves.toBe(true)
})

// A booter SIGKILLed between writing its `ready: false` record and binding leaves that
// record behind naming a live-looking pid. The old code waited out a ten-second boot grace
// before it dared reclaim it. The mutex proves it instead: we hold the mutex, a `ready:
// false` record is only written under the mutex, so its writer does not hold it, so it is
// abandoned — and abandoned records are taken NOW.
test('an abandoned booting record is taken immediately, with no grace period', async () => {
  // A live process that is not a daemon: exactly what a recycled pid looks like.
  const impostor = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  try {
    await new Promise<void>((resolve) => impostor.once('spawn', () => resolve()))
    writeDaemonState(pidPath, {
      pid: impostor.pid as number,
      socketPath,
      startedAt: Date.now(),
      ready: false,
    })

    const started = Date.now()
    const handle = await boot()
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(handle.pid).toBe(process.pid)
    expect(readDaemonState(pidPath)?.pid).toBe(process.pid)
    expect(readDaemonState(pidPath)?.ready).toBe(true)
  } finally {
    impostor.kill('SIGKILL')
  }
})

// The flagship property. A stop holds the mutex from the classification through the
// SIGTERM, the exit poll and the removal, so a boot racing it cannot slip in, find a
// half-dead daemon, and unlink a socket that is still being served.
//
// It is also the deadlock regression test. The daemon's own shutdown must RETAKE the
// mutex to clean up, and the stop is holding it — so the daemon takes it with a try-lock
// and never blocks. If it ever blocks instead, this stop cannot finish until
// `killTimeoutMs` expires and it SIGKILLs a daemon whose `onShutdown` never ran: the
// elapsed-time assertion is what catches that.
test('a stop and a boot never interleave', { timeout: 30_000 }, async () => {
  await spawnDaemon({ app: APP, entry: daemonEntry, socketPath, pidPath, logPath, env: childEnv })
  const childPID = readDaemonState(pidPath)?.pid as number
  expect(childPID).toBeGreaterThan(0)
  expect(childPID).not.toBe(process.pid)

  const started = Date.now()
  const stopping = stopDaemon({ app: APP, pidPath, killTimeoutMs: 5_000 })
  // Let the stop take the mutex first; the boot must then wait it out.
  await delay(50)
  const booting = boot({ lockTimeoutMs: 10_000 })

  const stopped = await stopping
  expect(stopped).toEqual({ stopped: true, pid: childPID })
  // A blocking cleanup in the daemon would make this ~5s (killTimeoutMs) or ~7s (plus the
  // SIGKILL grace) rather than a prompt SIGTERM shutdown.
  expect(Date.now() - started).toBeLessThan(3_000)

  const handle = await booting
  expect(handle.pid).toBe(process.pid)
  await expect(isSocketLive(socketPath)).resolves.toBe(true)
  // The stop's removal must not have taken the new daemon's record with it: the record on
  // disk names the booter, and it is ready.
  expect(readDaemonState(pidPath)?.pid).toBe(process.pid)
  expect(readDaemonState(pidPath)?.ready).toBe(true)
})
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @tejika/process exec vitest run test/mutex.test.ts`
Expected: PASS (4 tests).

If `'a stop and a boot never interleave'` takes more than ~3s, the daemon's `cleanUp` is blocking on the mutex — check that it passes `{ timeout: 0 }` to `acquireFileLock`. Do not raise the assertion's bound to make it pass.

- [ ] **Step 3: Commit**

```bash
pnpm exec biome check --write ./packages
git add packages/process/test/mutex.test.ts
git commit -m "test(process): pin the properties the boot mutex makes provable"
```

---

### Task 7: Versions, docs, and the full run

**Files:**
- Modify: `packages/env/package.json`
- Modify: `packages/process/package.json`
- Modify: `packages/process/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `@tejika/env@0.3.0`, `@tejika/process@0.3.0`.

- [ ] **Step 1: Bump the versions**

This repo has no changesets; versions are bumped by hand in the feature commit (see `119bc71`). Both bumps are minor under 0.x, which is where a 0.x breaking change goes.

`packages/env/package.json`: `"version": "0.2.0"` → `"version": "0.3.0"` (adds `getLockPath`).
`packages/process/package.json`: `"version": "0.2.0"` → `"version": "0.3.0"` (breaking).

- [ ] **Step 2: Update the `@tejika/process` README**

In the bullet list at the top, change the `runDaemon` line:

```md
- `runDaemon` — boot a daemon in the current process. Takes a short-lived boot
  mutex (`@sozai/lock`, at `<pidPath>.lock`) before classifying, cleaning up and
  binding its socket (no split-brain boot race), writes its presence record, and
  returns a `DaemonHandle`.
```

and the `getDaemonStatus` line:

```md
- `getDaemonStatus` — classify a daemon's state file into a `state` union, purely
  and lock-free (never mutates the filesystem, never blocks behind a boot).
```

In the `stopDaemon` example, update the reason list comment:

```ts
  // 'not-running' | 'not-owned' | 'timeout' | 'aborted' | 'busy' | 'error'
```

Replace the **Pidfile format change** paragraph at the end of the "Breaking changes" section with:

````md
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
````

- [ ] **Step 3: Run everything**

```bash
pnpm exec biome check --write ./packages
pnpm run build:types
pnpm exec turbo run test
```

Expected: all six workspace projects build their types; every package's tests pass. `@tejika/test`'s `waitForDaemonRunning` / `waitForDaemonStopped` call `getDaemonStatus({ app, pidPath })`, whose signature did not change — no edits should be needed there. If anything in `@tejika/test` fails to typecheck, it means `bootGraceMs` leaked into a call site; delete it rather than restoring the option.

- [ ] **Step 4: Commit**

```bash
git add packages/env/package.json packages/process/package.json packages/process/README.md
git commit -m "docs(process): document the @sozai/lock migration; release 0.3.0"
```

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/sozai-lock
gh pr create --title "feat(process)!: manage daemon locking with @sozai/lock" --body "$(cat <<'EOF'
## Summary

Replaces `@tejika/process`'s hand-rolled daemon lockfile with a short-lived
`@sozai/lock` mutex around the boot, stop and shutdown critical sections. Daemon
presence moves to its own state file (`state.ts`); `lock.ts` is deleted.

`@sozai/lock` was extracted from this very code, and fixed the bug it carried:
`reapLockFile` guarded the unlink on the lockfile's inode alone, and the kernel
recycles an inode number the moment a file is unlinked — so a reaper could unlink
the fresh lock a live daemon had just claimed on the recycled inode. Sozai guards
on a per-claim nonce, plus an OS boot ID so a pid is only trusted when it comes
from this boot.

Design: `docs/superpowers/specs/2026-07-14-sozai-lock-migration-design.md`.

## Breaking

- `LockRecord` → `DaemonState` (same fields, same file, same path).
- `bootGraceMs` is gone from `runDaemon` and `getDaemonStatus`. A `ready: false`
  record read while HOLDING the mutex was written by a process that does not hold
  it, so it is abandoned — a proof, replacing a ten-second guess.
- New: `lockPath` / `lockTimeoutMs` options, `StopResult.reason: 'busy'`, and a
  re-exported `TimeoutInterruption`.
- `pidPath`, `--pid-path`, `DaemonStatus` and `DaemonAlreadyRunningError` are
  unchanged.

`@tejika/env` gains `getLockPath`. `@tejika/env` and `@tejika/process` go to 0.3.0.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

**Spec coverage.** Every section of the design has a task: Paths → Task 1; `state.ts` → Task 2; Dependency → Task 3; Stop and the `classifyState` half of Boot → Task 4; Boot, Close and the `lock.ts` deletion → Task 5; Testing → Tasks 2, 4, 5, 6; Public API and the version bump → Tasks 4, 5, 7. The spec's two amendments (the try-lock in Close, no changeset) are listed as deviations above and are reflected in the spec file.

**Not in scope, by the spec's own decision.** The upstream `maxHoldTime` proposal on `FileLockOptions` is a follow-up: a pid recycled within one boot wedges the mutex, and after this change nothing unwedges it short of an `rm`. Accepted deliberately — it needs a SIGKILL *and* a same-boot pid collision, and its consequence is a wedged boot (loud, one file to delete) rather than a split brain (silent, corrupts data).
