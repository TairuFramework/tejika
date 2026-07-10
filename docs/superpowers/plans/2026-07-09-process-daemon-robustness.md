# `@tejika/process` Daemon Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks
**Spec:** `docs/superpowers/specs/2026-07-09-process-daemon-robustness-design.md`

**Goal:** Close the split-brain daemon boot race in `@tejika/process` and harden PID handling, shutdown, and timeout composition, while adding the two API seams consumers need.

**Architecture:** The pidfile becomes an exclusive `O_EXCL` claim taken *before* the socket binds, holding a JSON record (`pid`, `socketPath`, `startedAt`, `ready`) instead of a bare integer. The process that wins the claim is the only one permitted to touch the socket file; losers never unlink anything. Liveness classification moves to a pure, async function that distinguishes `ESRCH` (dead) from `EPERM` (alive, not ours) and cross-checks the socket, which also resolves PID recycling. `daemon.ts` splits into `lock.ts`, `daemon.ts`, `spawn.ts`, `deadline.ts`, and `errors.ts`.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 26, vitest, `@enkaku/client` / `@enkaku/server` / `@enkaku/protocol` / `@enkaku/socket` 0.18, `nano-spawn`, `@tejika/env`.

## Global Constraints

Copied from `AGENTS.md` and the spec. Every task's requirements implicitly include this section.

- Use `type`, never `interface`.
- Use `Array<T>`, never `T[]`.
- Never use `any` — use `unknown`, `Record<string, unknown>`, or a specific type.
- No lowercase abbreviations in names: `ID` not `Id`, `HTTP` not `Http`, `PID` not `Pid`. A leading abbreviation in camelCase is all-lowercase, so the variable/option name `pidPath` is correct and stays.
- No TS `private`/`readonly` **access modifiers** — use ES private fields (`#field`) plus getters. A `readonly` class field used as a literal discriminant is not an access modifier and is fine.
- Use `pnpm`/`pnpx`, never `npm`/`npx`.
- Never edit generated files (`lib/`).
- Never work around bugs in `@enkaku/*` — fix at the source repo. Two such bugs are filed in Task 13.
- POSIX only. `getSocketPath` returns a filesystem path with no `\\.\pipe\` branch; assume unix domain sockets throughout.
- **This machine only:** an `rtk` shim intercepts `pnpm run <script>` and bare `grep`. Run repo scripts as `rtk proxy pnpm run <script>`, or invoke tools directly (`pnpm exec vitest run`, `pnpm exec biome check`).
- Lint with `pnpm exec biome check --write ./packages` (Biome, not eslint).
- Run one package's tests from its directory: `cd packages/process && pnpm exec vitest run <file>`.

**Defaults fixed by the spec** — use these exact values:

| Constant | Value |
|---|---|
| `bootGraceMs` | `10_000` |
| `shutdownTimeoutMs` | `5_000` |
| `killTimeoutMs` | `5_000` |
| `ensureDaemon` `timeoutMs` | `10_000` |
| reconnect stability window | `2_000` |
| claim retry attempts | `3` |
| `handleSignals` | `true` |
| `waitForExit` | `true` |

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/process/src/errors.ts` *(new)* | `DaemonAlreadyRunningError`, `DaemonBootError` |
| `packages/process/src/lock.ts` *(new)* | `LockRecord`, `claimDaemonLock`, `readLockRecord`, `reapLockFile` |
| `packages/process/src/deadline.ts` *(new)* | `Deadline`, `createDeadline` |
| `packages/process/src/socket.ts` | `probeSocket`, `isSocketLive`, `waitForSocket`, `safeRemove` |
| `packages/process/src/status.ts` | `classifyRecord` (internal), `getDaemonStatus`, `stopDaemon` |
| `packages/process/src/daemon.ts` | `runDaemon` + `DaemonHandle` only |
| `packages/process/src/spawn.ts` *(new, split from `daemon.ts`)* | `spawnDaemon` |
| `packages/process/src/client.ts` | `createDaemonTransport`, `createDaemonClient`, `nextBackoff` |
| `packages/process/src/controller.ts` | `ensureDaemon` |
| `packages/process/src/index.ts` | Public exports |
| `packages/process/README.md` *(new)* | Breaking-change record (no `.changeset/` in this repo yet) |
| `packages/env/src/paths.ts` | `getPIDPath` (hard rename from `getPidPath`) |
| `packages/test/src/daemon.ts` | Updated for the async `DaemonStatus` union |

Tests mirror the source: `lock.test.ts`, `deadline.test.ts`, `socket.test.ts`, `status.test.ts`, `daemon.test.ts`, `spawn.test.ts`, `controller.test.ts`, `client.test.ts`, plus fixtures under `test/fixtures/`.

**Task order.** Task 1 (`getPIDPath` rename) comes first because every later task imports it and it has no dependencies — this keeps the tree typechecking at every commit. Tasks 2–4 are leaf modules. Task 5 (`status`) consumes them. Task 6 (`daemon`) is where H3 closes. Tasks 7–10 build outward. Tasks 11–12 fix in-repo consumers. Task 13 documents and files upstream.

**Out of scope, recorded not fixed.** Sakui (`/Users/paul/dev/yulsi/sakui`) imports `getPidPath` (`apps/cli/src/paths.ts:3`), `spawnDaemon` (`apps/cli/src/daemon/controller.ts:9`), `getDaemonStatus` (`apps/cli/src/daemon/lifecycle.ts:2`, `apps/cli/src/commands/status.ts:1`, `apps/cli/src/commands/stop.ts:1`, `apps/cli/test/controller.test.ts:6`), and `stopDaemon` (`apps/cli/src/commands/stop.ts:1`). It lives in its own repo and absorbs these changes when it next bumps. Task 13 files the backlog item.

---

### Task 1: Rename `getPidPath` → `getPIDPath` in `@tejika/env`

**Files:**
- Modify: `packages/env/src/paths.ts:20-22`
- Modify: `packages/env/src/index.ts:2`
- Modify: `packages/env/test/paths.test.ts:2,31,33,36-37,68-70`
- Modify: `packages/process/src/status.ts:2,7` and `packages/process/src/daemon.ts:20,46` (import sites; both files are rewritten later, this only keeps the tree green)
- Modify: `docs/agents/architecture.md:12`

**Interfaces:**
- Consumes: nothing.
- Produces: `function getPIDPath(app: string): string`. The old name is deleted — no alias.

Hard rename, per the spec. `getPidPath` violates the AGENTS.md guardrail (`ID` not `Id`). The env var `TEJIKA_*_PID_PATH` and the `pidPath` variable name are unchanged and already compliant.

Coordination: `docs/agents/plans/backlog/2026-07-06-env-paths-hardening.md:11` also flags this rename. After this task, strike that line from the backlog item so the two do not collide.

- [ ] **Step 1: Update the test**

In `packages/env/test/paths.test.ts`, replace every `getPidPath` with `getPIDPath` — the import on line 2, the `describe` title on line 31, and the three call sites on lines 33, 37, and 69. Leave the `MYAPP_PID_PATH` env var names untouched.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/env && pnpm exec vitest run test/paths.test.ts`
Expected: FAIL with `"getPIDPath" is not exported by "../src/paths.js"`.

- [ ] **Step 3: Rename the export**

In `packages/env/src/paths.ts`, replace the `getPidPath` function:

```ts
export function getPIDPath(app: string): string {
  return getAppEnvVar(app, 'PID_PATH') ?? join(getStateDir(app), `${app}.pid`)
}
```

In `packages/env/src/index.ts`:

```ts
export { getDataDir, getPIDPath, getSocketPath, getStateDir } from './paths.js'
```

In `packages/process/src/status.ts`, change the import on line 2 and the call on line 7 to `getPIDPath`. In `packages/process/src/daemon.ts`, change line 20's import and line 46's call the same way. Both files are replaced wholesale by later tasks; this keeps the tree typechecking in the meantime.

In `docs/agents/architecture.md:12`, change `getPidPath` to `getPIDPath`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/env && pnpm exec vitest run test/paths.test.ts`
Expected: PASS.

Run: `rtk proxy pnpm build:types`
Expected: PASS — no unresolved `getPidPath` anywhere.

- [ ] **Step 5: Strike the backlog line, lint, and commit**

Remove the `getPidPath` naming line from `docs/agents/plans/backlog/2026-07-06-env-paths-hardening.md:11`, leaving the rest of that item intact.

```bash
pnpm exec biome check --write ./packages
git add packages/env/src/paths.ts packages/env/src/index.ts packages/env/test/paths.test.ts \
  packages/process/src/status.ts packages/process/src/daemon.ts \
  docs/agents/architecture.md docs/agents/plans/backlog/2026-07-06-env-paths-hardening.md
git commit -m "refactor(env)!: rename getPidPath to getPIDPath"
```

---

### Task 2: Typed errors

**Files:**
- Create: `packages/process/src/errors.ts`
- Test: `packages/process/test/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DaemonAlreadyRunningError` — constructor `(pid: number, socketPath: string)`, fields `code: 'DAEMON_ALREADY_RUNNING'`, getters `pid`, `socketPath`. `DaemonBootError` — constructor `(message: string, details: { logPath: string; cause?: unknown })`, field `code: 'DAEMON_BOOT_FAILED'`, getter `logPath`.

A failed stop is reported through `StopResult.reason` in Task 5, never thrown — do not add a `DaemonStopTimeoutError`.

- [ ] **Step 1: Write the failing test**

Create `packages/process/test/errors.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { DaemonAlreadyRunningError, DaemonBootError } from '../src/errors.js'

describe('DaemonAlreadyRunningError', () => {
  test('carries the pid, socket path, and a stable code', () => {
    const err = new DaemonAlreadyRunningError(4321, '/tmp/app.sock')
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('DAEMON_ALREADY_RUNNING')
    expect(err.pid).toBe(4321)
    expect(err.socketPath).toBe('/tmp/app.sock')
    expect(err.message).toContain('4321')
    expect(err.name).toBe('DaemonAlreadyRunningError')
  })
})

describe('DaemonBootError', () => {
  test('carries the log path and preserves the cause', () => {
    const cause = new Error('exit 1')
    const err = new DaemonBootError('daemon exited during boot', {
      logPath: '/tmp/daemon.log',
      cause,
    })
    expect(err.code).toBe('DAEMON_BOOT_FAILED')
    expect(err.logPath).toBe('/tmp/daemon.log')
    expect(err.cause).toBe(cause)
    expect(err.message).toContain('/tmp/daemon.log')
    expect(err.name).toBe('DaemonBootError')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/process && pnpm exec vitest run test/errors.test.ts`
Expected: FAIL with `Failed to resolve import "../src/errors.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/process/src/errors.ts`:

```ts
/** A live daemon (or one mid-boot) already holds the lock for this app. */
export class DaemonAlreadyRunningError extends Error {
  readonly code = 'DAEMON_ALREADY_RUNNING' as const
  #pid: number
  #socketPath: string

  constructor(pid: number, socketPath: string) {
    super(`daemon already running (pid ${pid}, socket ${socketPath})`)
    this.name = 'DaemonAlreadyRunningError'
    this.#pid = pid
    this.#socketPath = socketPath
  }

  get pid(): number {
    return this.#pid
  }

  get socketPath(): string {
    return this.#socketPath
  }
}

/** The spawned daemon died (or never bound) before its socket accepted a connection. */
export class DaemonBootError extends Error {
  readonly code = 'DAEMON_BOOT_FAILED' as const
  #logPath: string

  constructor(message: string, details: { logPath: string; cause?: unknown }) {
    super(`${message} — see ${details.logPath}`, { cause: details.cause })
    this.name = 'DaemonBootError'
    this.#logPath = details.logPath
  }

  get logPath(): string {
    return this.#logPath
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/process && pnpm exec vitest run test/errors.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec biome check --write ./packages
git add packages/process/src/errors.ts packages/process/test/errors.test.ts
git commit -m "feat(process): add typed daemon errors"
```

---

### Task 3: The daemon lock

**Files:**
- Create: `packages/process/src/lock.ts`
- Test: `packages/process/test/lock.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type LockRecord = { pid: number; socketPath: string; startedAt: number; ready: boolean }`
  - `type DaemonLock = { record: LockRecord; markReady(): void; release(): void }`
  - `type ClaimResult = { lock: DaemonLock } | { conflict: LockRecord | null }`
  - `function claimDaemonLock(pidPath: string, record: LockRecord): ClaimResult`
  - `function readLockRecord(pidPath: string): LockRecord | null`
  - `function reapLockFile(pidPath: string, expectedInode?: number): boolean`

`readLockRecord` returns `null` for a missing, unreadable, malformed, or non-conforming file — a corrupt record is indistinguishable from no record, and both are treated as stale by callers. That is the `NaN`-pid fix.

`reapLockFile` unlinks only while the file's inode still matches `expectedInode` (captured now when omitted). This narrows, but does not close, the window in which two reapers both delete a lockfile a third process has since freshly claimed. Task 6's `markReady` rewrite and its live-socket check close what remains.

- [ ] **Step 1: Write the failing test**

Create `packages/process/test/lock.test.ts`:

```ts
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { claimDaemonLock, type LockRecord, readLockRecord, reapLockFile } from '../src/lock.js'

let dir: string
let pidPath: string

const record = (over: Partial<LockRecord> = {}): LockRecord => ({
  pid: 1234,
  socketPath: '/tmp/app.sock',
  startedAt: 1_700_000_000_000,
  ready: false,
  ...over,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-lock-'))
  pidPath = join(dir, 'app.pid')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('claimDaemonLock', () => {
  test('claims a free path and writes the record', () => {
    const result = claimDaemonLock(pidPath, record())
    expect('lock' in result).toBe(true)
    expect(readLockRecord(pidPath)).toEqual(record())
  })

  test('a second claim on a held path returns the existing record as a conflict', () => {
    claimDaemonLock(pidPath, record({ pid: 111 }))
    const second = claimDaemonLock(pidPath, record({ pid: 222 }))
    expect(second).toEqual({ conflict: record({ pid: 111 }) })
    // The loser must not have overwritten the winner's record.
    expect(readLockRecord(pidPath)?.pid).toBe(111)
  })

  test('a corrupt existing file conflicts with a null record', () => {
    writeFileSync(pidPath, 'not json at all', 'utf8')
    expect(claimDaemonLock(pidPath, record())).toEqual({ conflict: null })
  })
})

describe('readLockRecord', () => {
  test('returns null when the file is absent', () => {
    expect(readLockRecord(join(dir, 'absent.pid'))).toBeNull()
  })

  test('returns null for a record missing required fields', () => {
    writeFileSync(pidPath, JSON.stringify({ pid: 5 }), 'utf8')
    expect(readLockRecord(pidPath)).toBeNull()
  })

  test('returns null for a record with a non-numeric pid', () => {
    writeFileSync(pidPath, JSON.stringify({ ...record(), pid: 'abc' }), 'utf8')
    expect(readLockRecord(pidPath)).toBeNull()
  })
})

describe('DaemonLock.markReady', () => {
  test('flips ready to true on disk and in the held record', () => {
    const result = claimDaemonLock(pidPath, record())
    if (!('lock' in result)) throw new Error('expected a claim')
    result.lock.markReady()
    expect(readLockRecord(pidPath)?.ready).toBe(true)
    expect(result.lock.record.ready).toBe(true)
  })

  test('rewrites the lockfile when a racing reaper removed it', () => {
    const result = claimDaemonLock(pidPath, record())
    if (!('lock' in result)) throw new Error('expected a claim')
    rmSync(pidPath)
    result.lock.markReady()
    expect(readLockRecord(pidPath)).toEqual(record({ ready: true }))
  })

  test('reclaims the lockfile when it was replaced by a foreign record', () => {
    const result = claimDaemonLock(pidPath, record({ pid: 111 }))
    if (!('lock' in result)) throw new Error('expected a claim')
    writeFileSync(pidPath, JSON.stringify(record({ pid: 999 })), 'utf8')
    result.lock.markReady()
    expect(readLockRecord(pidPath)?.pid).toBe(111)
  })
})

describe('DaemonLock.release', () => {
  test('removes our lockfile', () => {
    const result = claimDaemonLock(pidPath, record())
    if (!('lock' in result)) throw new Error('expected a claim')
    result.lock.release()
    expect(readLockRecord(pidPath)).toBeNull()
  })

  test('leaves a foreign record in place', () => {
    const result = claimDaemonLock(pidPath, record({ pid: 111 }))
    if (!('lock' in result)) throw new Error('expected a claim')
    writeFileSync(pidPath, JSON.stringify(record({ pid: 999 })), 'utf8')
    result.lock.release()
    expect(readLockRecord(pidPath)?.pid).toBe(999)
  })

  test('tolerates an already-removed lockfile', () => {
    const result = claimDaemonLock(pidPath, record())
    if (!('lock' in result)) throw new Error('expected a claim')
    rmSync(pidPath)
    expect(() => result.lock.release()).not.toThrow()
  })
})

describe('reapLockFile', () => {
  test('removes an existing lockfile and reports true', () => {
    writeFileSync(pidPath, JSON.stringify(record()), 'utf8')
    expect(reapLockFile(pidPath)).toBe(true)
    expect(readLockRecord(pidPath)).toBeNull()
  })

  test('reports false when the file is already gone', () => {
    expect(reapLockFile(pidPath)).toBe(false)
  })

  test('refuses to remove a file whose inode is not the expected one', () => {
    writeFileSync(pidPath, JSON.stringify(record({ pid: 999 })), 'utf8')
    const actualInode = statSync(pidPath).ino
    // Simulates: we read record A, someone replaced the file, we try to reap A.
    expect(reapLockFile(pidPath, actualInode + 1)).toBe(false)
    expect(readLockRecord(pidPath)?.pid).toBe(999)
  })

  test('removes the file when the expected inode still matches', () => {
    writeFileSync(pidPath, JSON.stringify(record()), 'utf8')
    expect(reapLockFile(pidPath, statSync(pidPath).ino)).toBe(true)
    expect(readLockRecord(pidPath)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/process && pnpm exec vitest run test/lock.test.ts`
Expected: FAIL with `Failed to resolve import "../src/lock.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/process/src/lock.ts`:

```ts
import { closeSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'

/**
 * The on-disk lock. `ready` is false between claiming the lock and binding the
 * socket: a concurrent observer must be able to tell "booting" from "crashed
 * after claiming", and only the record can carry that distinction.
 */
export type LockRecord = {
  pid: number
  socketPath: string
  startedAt: number
  ready: boolean
}

export type DaemonLock = {
  record: LockRecord
  /** Rewrite the record with `ready: true`, restoring it if a racing reaper removed it. */
  markReady(): void
  /** Unlink the lockfile, but only while it still holds our record. */
  release(): void
}

export type ClaimResult = { lock: DaemonLock } | { conflict: LockRecord | null }

function isLockRecord(value: unknown): value is LockRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.pid === 'number' &&
    Number.isInteger(record.pid) &&
    typeof record.socketPath === 'string' &&
    typeof record.startedAt === 'number' &&
    typeof record.ready === 'boolean'
  )
}

/**
 * Read the record, or null when the file is absent, unreadable, or does not hold
 * a conforming record. Callers treat a corrupt record exactly as they treat a
 * missing one: stale.
 */
export function readLockRecord(pidPath: string): LockRecord | null {
  let raw: string
  try {
    raw = readFileSync(pidPath, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return isLockRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function inodeOf(pidPath: string): number | null {
  try {
    return statSync(pidPath).ino
  } catch {
    return null
  }
}

function writeRecord(pidPath: string, record: LockRecord): void {
  writeFileSync(pidPath, JSON.stringify(record), 'utf8')
}

/**
 * Unlink the lockfile only if its inode still matches `expectedInode` (captured
 * now when omitted). Returns whether the file was removed.
 */
export function reapLockFile(pidPath: string, expectedInode?: number): boolean {
  const expected = expectedInode ?? inodeOf(pidPath)
  if (expected == null) return false
  if (inodeOf(pidPath) !== expected) return false
  try {
    rmSync(pidPath)
    return true
  } catch {
    return false
  }
}

/**
 * Take an exclusive claim on `pidPath` via `O_CREAT | O_EXCL` — the single atomic
 * primitive this design rests on. The winner alone may touch the socket file;
 * losers get the conflicting record (or null when it is corrupt) and must unlink
 * nothing.
 */
export function claimDaemonLock(pidPath: string, record: LockRecord): ClaimResult {
  let fd: number
  try {
    fd = openSync(pidPath, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    return { conflict: readLockRecord(pidPath) }
  }
  closeSync(fd)
  writeRecord(pidPath, record)

  const held: LockRecord = { ...record }

  return {
    lock: {
      record: held,
      markReady(): void {
        held.ready = true
        // Unconditional: this both flips `ready` and recovers our lockfile if a
        // racing reaper removed it or wrote its own record over ours.
        writeRecord(pidPath, held)
      },
      release(): void {
        // Never remove a lockfile that is no longer ours.
        if (readLockRecord(pidPath)?.pid === held.pid) rmSync(pidPath, { force: true })
      },
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/process && pnpm exec vitest run test/lock.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec biome check --write ./packages
git add packages/process/src/lock.ts packages/process/test/lock.test.ts
git commit -m "feat(process): add exclusive daemon lock with a JSON record"
```

---

### Task 4: Deadline and socket probing

**Files:**
- Create: `packages/process/src/deadline.ts`
- Replace: `packages/process/src/socket.ts`
- Test: `packages/process/test/deadline.test.ts`, `packages/process/test/socket.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Deadline = { remaining(): number; expired(): boolean; signal: AbortSignal }`
  - `function createDeadline(timeoutMs?: number, signal?: AbortSignal): Deadline`
  - `type SocketProbe = 'live' | 'dead' | 'forbidden'`
  - `function probeSocket(socketPath: string): Promise<SocketProbe>`
  - `function isSocketLive(socketPath: string): Promise<boolean>` — true for `'live'` and `'forbidden'`
  - `type WaitForSocketOptions = { deadline?: Deadline; interval?: number }`
  - `function waitForSocket(socketPath: string, options?: WaitForSocketOptions): Promise<void>`
  - `function safeRemove(socketPath: string): void` — unchanged

`EACCES` and `EPERM` from `connectSocket` mean *something is listening* and we merely lack permission. They must not count as dead, because a dead verdict authorises unlinking the socket file.

`createDeadline()` with no arguments yields `remaining() === Infinity`, `expired() === false`, and a never-aborting signal.

- [ ] **Step 1: Write the failing tests**

Create `packages/process/test/deadline.test.ts`:

```ts
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, test } from 'vitest'
import { createDeadline } from '../src/deadline.js'

describe('createDeadline', () => {
  test('is unbounded with no timeout and no signal', () => {
    const deadline = createDeadline()
    expect(deadline.remaining()).toBe(Number.POSITIVE_INFINITY)
    expect(deadline.expired()).toBe(false)
    expect(deadline.signal.aborted).toBe(false)
  })

  test('counts down and expires', async () => {
    const deadline = createDeadline(50)
    expect(deadline.remaining()).toBeGreaterThan(0)
    expect(deadline.remaining()).toBeLessThanOrEqual(50)
    await delay(80)
    expect(deadline.expired()).toBe(true)
    expect(deadline.remaining()).toBe(0)
    expect(deadline.signal.aborted).toBe(true)
  })

  test('aborts when the caller signal aborts, before the timer fires', () => {
    const controller = new AbortController()
    const deadline = createDeadline(10_000, controller.signal)
    expect(deadline.signal.aborted).toBe(false)
    controller.abort()
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.expired()).toBe(true)
  })

  test('an already-aborted caller signal expires the deadline immediately', () => {
    expect(createDeadline(10_000, AbortSignal.abort()).expired()).toBe(true)
  })

  test('a caller signal with no timeout still expires on abort', () => {
    const controller = new AbortController()
    const deadline = createDeadline(undefined, controller.signal)
    expect(deadline.expired()).toBe(false)
    controller.abort()
    expect(deadline.expired()).toBe(true)
  })
})
```

Create `packages/process/test/socket.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createDeadline } from '../src/deadline.js'
import { isSocketLive, probeSocket, waitForSocket } from '../src/socket.js'

let dir: string
let socketPath: string
let server: Server | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-socket-'))
  socketPath = join(dir, 'app.sock')
})

afterEach(async () => {
  if (server != null) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
  rmSync(dir, { recursive: true, force: true })
})

const listen = async (): Promise<void> => {
  server = createServer()
  await new Promise<void>((resolve) => server?.listen(socketPath, resolve))
}

describe('probeSocket', () => {
  test('reports dead when nothing is listening', async () => {
    await expect(probeSocket(socketPath)).resolves.toBe('dead')
  })

  test('reports live when a server is listening', async () => {
    await listen()
    await expect(probeSocket(socketPath)).resolves.toBe('live')
  })
})

describe('isSocketLive', () => {
  test('is false for a missing socket', async () => {
    await expect(isSocketLive(socketPath)).resolves.toBe(false)
  })

  test('is true for a listening socket', async () => {
    await listen()
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
  })
})

describe('waitForSocket', () => {
  test('resolves once the socket accepts', async () => {
    setTimeout(() => void listen(), 20)
    await expect(
      waitForSocket(socketPath, { deadline: createDeadline(2000), interval: 10 }),
    ).resolves.toBeUndefined()
  })

  test('rejects when the deadline expires', async () => {
    await expect(
      waitForSocket(socketPath, { deadline: createDeadline(60), interval: 10 }),
    ).rejects.toThrow(/Timed out waiting for socket/)
  })

  test('rejects when the caller aborts mid-wait', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    await expect(
      waitForSocket(socketPath, {
        deadline: createDeadline(5000, controller.signal),
        interval: 10,
      }),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/process && pnpm exec vitest run test/deadline.test.ts test/socket.test.ts`
Expected: FAIL — `Failed to resolve import "../src/deadline.js"`, and `probeSocket` is not exported from `socket.ts`.

- [ ] **Step 3: Write the implementations**

Create `packages/process/src/deadline.ts`:

```ts
/** A shared time budget: a countdown plus the signal that fires at zero. */
export type Deadline = {
  /** Milliseconds left, or `Infinity` when unbounded. Never negative. */
  remaining(): number
  expired(): boolean
  signal: AbortSignal
}

/**
 * Compose a caller's `AbortSignal` with a timeout into one budget that threads
 * through every phase of an operation, so the phases compose instead of each
 * imposing its own independent timeout.
 */
export function createDeadline(timeoutMs?: number, signal?: AbortSignal): Deadline {
  const signals: Array<AbortSignal> = []
  if (signal != null) signals.push(signal)
  if (timeoutMs != null) signals.push(AbortSignal.timeout(timeoutMs))

  // AbortSignal.any([]) is never aborted, which is exactly the unbounded case.
  const combined = AbortSignal.any(signals)
  const end = timeoutMs == null ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs

  const remaining = (): number =>
    end === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Math.max(0, end - Date.now())

  return {
    remaining,
    expired: (): boolean => combined.aborted || remaining() === 0,
    signal: combined,
  }
}
```

Replace `packages/process/src/socket.ts` entirely:

```ts
import { rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { connectSocket } from '@enkaku/socket'
import { createDeadline, type Deadline } from './deadline.js'

/**
 * `forbidden` means something IS listening but we may not connect (EACCES /
 * EPERM — typically another user's daemon). It must never be treated as dead:
 * a dead verdict authorises unlinking the socket file.
 */
export type SocketProbe = 'live' | 'dead' | 'forbidden'

const FORBIDDEN_CODES = new Set(['EACCES', 'EPERM'])

export async function probeSocket(socketPath: string): Promise<SocketProbe> {
  try {
    const socket = await connectSocket(socketPath)
    socket.destroy()
    return 'live'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? ''
    return FORBIDDEN_CODES.has(code) ? 'forbidden' : 'dead'
  }
}

/** True if something is actively listening on the socket (not just a stale file). */
export async function isSocketLive(socketPath: string): Promise<boolean> {
  return (await probeSocket(socketPath)) !== 'dead'
}

export type WaitForSocketOptions = { deadline?: Deadline; interval?: number }

/** Poll until the socket accepts a connection, or reject once the deadline expires. */
export async function waitForSocket(
  socketPath: string,
  options: WaitForSocketOptions = {},
): Promise<void> {
  const deadline = options.deadline ?? createDeadline(3000)
  const interval = options.interval ?? 50
  for (;;) {
    if (await isSocketLive(socketPath)) return
    if (deadline.expired()) throw new Error(`Timed out waiting for socket ${socketPath}`)
    // Rejects with an AbortError if the deadline's signal fires mid-sleep.
    await delay(Math.min(interval, deadline.remaining()), undefined, { signal: deadline.signal })
  }
}

/** Remove a socket file, tolerating concurrent removal (ENOENT). */
export function safeRemove(socketPath: string): void {
  try {
    rmSync(socketPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/process && pnpm exec vitest run test/deadline.test.ts test/socket.test.ts`
Expected: PASS, 5 + 7 tests.

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec biome check --write ./packages
git add packages/process/src/deadline.ts packages/process/src/socket.ts \
  packages/process/test/deadline.test.ts packages/process/test/socket.test.ts
git commit -m "feat(process): add deadline budget and tri-state socket probe"
```

---

### Task 5: Status classification and stopDaemon

**Files:**
- Replace: `packages/process/src/status.ts`
- Create: `packages/process/test/status.test.ts`
- Modify: `packages/process/test/daemon.test.ts` — delete its `getDaemonStatus` test (it moves here). Task 6 rewrites the rest of that file.

**Interfaces:**
- Consumes: `LockRecord`, `readLockRecord`, `reapLockFile` (Task 3); `SocketProbe`, `probeSocket` (Task 4); `createDeadline` (Task 4); `getPIDPath` (Task 1).
- Produces:
  - `type DaemonStatus` — the discriminated union below
  - `type StatusDeps = { kill: (pid: number, signal: 0) => void; probe: (socketPath: string) => Promise<SocketProbe> }`
  - `const DEFAULT_BOOT_GRACE_MS = 10_000`
  - `function classifyRecord(record: LockRecord | null, options: { bootGraceMs: number; now: number }, deps?: StatusDeps): Promise<DaemonStatus>` — exported for tests, **not** re-exported from `index.ts`
  - `function getDaemonStatus(opts: { app: string; pidPath?: string; bootGraceMs?: number }): Promise<DaemonStatus>`
  - `type StopResult = { stopped: boolean; pid?: number; reason?: 'not-running' | 'not-owned' | 'timeout' }`
  - `type StopDaemonOptions = { app: string; pidPath?: string; waitForExit?: boolean; killTimeoutMs?: number; signal?: AbortSignal }`
  - `function stopDaemon(opts: StopDaemonOptions): Promise<StopResult>`

`classifyRecord` takes `kill` and `probe` as injected dependencies. That is the only way to test `EPERM` and PID recycling without a second user account or a genuinely recycled PID.

`getDaemonStatus` is now **pure**: it never reaps the pidfile. Reaping happens only in Task 6's claim path, where it is inode-guarded. That change alone stops a live daemon's lockfile being reaped when `kill` reports `EPERM`.

- [ ] **Step 1: Write the failing test**

Create `packages/process/test/status.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import type { LockRecord } from '../src/lock.js'
import type { SocketProbe } from '../src/socket.js'
import { classifyRecord, type StatusDeps } from '../src/status.js'

const NOW = 1_700_000_000_000
const OPTIONS = { bootGraceMs: 10_000, now: NOW }

const record = (over: Partial<LockRecord> = {}): LockRecord => ({
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

describe('classifyRecord', () => {
  test('no record means not-running', async () => {
    await expect(classifyRecord(null, OPTIONS, deps())).resolves.toEqual({ state: 'not-running' })
  })

  test('ESRCH means stale', async () => {
    const result = await classifyRecord(record(), OPTIONS, deps({ kill: throwing('ESRCH') }))
    expect(result).toEqual({ state: 'stale', pid: 1234 })
  })

  test('EPERM means running-not-owned, never stale', async () => {
    const result = await classifyRecord(record(), OPTIONS, deps({ kill: throwing('EPERM') }))
    expect(result).toEqual({
      state: 'running-not-owned',
      pid: 1234,
      socketPath: '/tmp/app.sock',
    })
  })

  test('a live process with a live socket is running', async () => {
    const result = await classifyRecord(record(), OPTIONS, deps())
    expect(result).toEqual({ state: 'running', pid: 1234, socketPath: '/tmp/app.sock' })
  })

  test('a forbidden socket still counts as running', async () => {
    const result = await classifyRecord(record(), OPTIONS, deps({ probe: async () => 'forbidden' }))
    expect(result.state).toBe('running')
  })

  test('a live process whose socket is dead is a recycled pid: stale', async () => {
    const result = await classifyRecord(record(), OPTIONS, deps({ probe: async () => 'dead' }))
    expect(result).toEqual({ state: 'stale', pid: 1234 })
  })

  test('an unready record within the boot grace is booting', async () => {
    const result = await classifyRecord(
      record({ ready: false, startedAt: NOW - 5_000 }),
      OPTIONS,
      deps({ probe: async () => 'dead' }),
    )
    expect(result).toEqual({ state: 'booting', pid: 1234, socketPath: '/tmp/app.sock' })
  })

  test('an unready record past the boot grace is stale', async () => {
    const result = await classifyRecord(
      record({ ready: false, startedAt: NOW - 11_000 }),
      OPTIONS,
      deps({ probe: async () => 'dead' }),
    )
    expect(result).toEqual({ state: 'stale', pid: 1234 })
  })

  test('an unready record is not probed at all — probing would race the bind', async () => {
    let probed = false
    await classifyRecord(
      record({ ready: false, startedAt: NOW }),
      OPTIONS,
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/process && pnpm exec vitest run test/status.test.ts`
Expected: FAIL — `classifyRecord` is not exported from `status.ts`.

- [ ] **Step 3: Write the implementation**

Replace `packages/process/src/status.ts` entirely:

```ts
import { setTimeout as delay } from 'node:timers/promises'
import { getPIDPath } from '@tejika/env'
import { createDeadline, type Deadline } from './deadline.js'
import { type LockRecord, readLockRecord, reapLockFile } from './lock.js'
import { probeSocket, type SocketProbe } from './socket.js'

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

export const DEFAULT_BOOT_GRACE_MS = 10_000

type Liveness = 'alive' | 'dead' | 'not-owned'

function checkLiveness(pid: number, kill: StatusDeps['kill']): Liveness {
  try {
    kill(pid, 0)
    return 'alive'
  } catch (err) {
    // Only ESRCH means the process is gone. EPERM means it exists and belongs to
    // another user — treating that as dead would reap a live daemon's lockfile
    // and, in stopDaemon, signal an innocent process.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'not-owned' : 'dead'
  }
}

export async function classifyRecord(
  record: LockRecord | null,
  options: { bootGraceMs: number; now: number },
  deps: StatusDeps = DEFAULT_DEPS,
): Promise<DaemonStatus> {
  // A corrupt record reads as null and is indistinguishable from no record.
  if (record == null) return { state: 'not-running' }

  const liveness = checkLiveness(record.pid, deps.kill)
  if (liveness === 'dead') return { state: 'stale', pid: record.pid }
  if (liveness === 'not-owned') {
    return { state: 'running-not-owned', pid: record.pid, socketPath: record.socketPath }
  }

  if (!record.ready) {
    // Claimed but not yet bound. Probing would race the bind, so trust the clock.
    return options.now - record.startedAt < options.bootGraceMs
      ? { state: 'booting', pid: record.pid, socketPath: record.socketPath }
      : { state: 'stale', pid: record.pid }
  }

  if ((await deps.probe(record.socketPath)) === 'dead') {
    // The pid is alive but its socket is not. Either the pid was recycled, or the
    // daemon's socket file was unlinked out from under it. Both leave the daemon
    // unreachable by every client, so reclaiming the lock is correct.
    return { state: 'stale', pid: record.pid }
  }
  return { state: 'running', pid: record.pid, socketPath: record.socketPath }
}

/**
 * Classify the daemon's lockfile. Pure: unlike the previous implementation this
 * never reaps a stale lockfile as a side effect. Reaping belongs to the boot
 * claim path, where it is inode-guarded.
 */
export async function getDaemonStatus(opts: {
  app: string
  pidPath?: string
  bootGraceMs?: number
}): Promise<DaemonStatus> {
  const pidPath = opts.pidPath ?? getPIDPath(opts.app)
  return await classifyRecord(readLockRecord(pidPath), {
    bootGraceMs: opts.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS,
    now: Date.now(),
  })
}

export type StopResult = {
  stopped: boolean
  pid?: number
  reason?: 'not-running' | 'not-owned' | 'timeout'
}

export type StopDaemonOptions = {
  app: string
  pidPath?: string
  /** Poll until the process exits, escalating to SIGKILL. Default true. */
  waitForExit?: boolean
  killTimeoutMs?: number
  signal?: AbortSignal
}

const EXIT_POLL_INTERVAL_MS = 50
const SIGKILL_GRACE_MS = 2_000

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    // EPERM means it is still there, owned by someone else.
    return (err as NodeJS.ErrnoException).code !== 'EPERM'
  }
}

async function pollUntilGone(pid: number, deadline: Deadline): Promise<boolean> {
  for (;;) {
    if (isGone(pid)) return true
    if (deadline.expired()) return false
    try {
      await delay(EXIT_POLL_INTERVAL_MS, undefined, { signal: deadline.signal })
    } catch {
      return isGone(pid)
    }
  }
}

/**
 * Send a signal, treating "already exited" as success. ESRCH between the status
 * read and the kill means the daemon exited on its own — a race we win, not an
 * error. Returns a terminal result, or null to continue.
 */
function signalTolerantly(pid: number, signal: 'SIGTERM' | 'SIGKILL'): StopResult | null {
  try {
    process.kill(pid, signal)
    return null
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return { stopped: true, pid }
    if (code === 'EPERM') return { stopped: false, pid, reason: 'not-owned' }
    throw err
  }
}

export async function stopDaemon(opts: StopDaemonOptions): Promise<StopResult> {
  const pidPath = opts.pidPath ?? getPIDPath(opts.app)
  const status = await getDaemonStatus({ app: opts.app, pidPath })

  if (status.state === 'not-running') return { stopped: false, reason: 'not-running' }
  if (status.state === 'stale') {
    reapLockFile(pidPath)
    return { stopped: false, pid: status.pid, reason: 'not-running' }
  }
  if (status.state === 'running-not-owned') {
    return { stopped: false, pid: status.pid, reason: 'not-owned' }
  }

  const pid = status.pid
  const early = signalTolerantly(pid, 'SIGTERM')
  if (early != null) {
    if (early.stopped) reapLockFile(pidPath)
    return early
  }

  if (opts.waitForExit === false) return { stopped: true, pid }

  const killTimeoutMs = opts.killTimeoutMs ?? 5_000
  if (await pollUntilGone(pid, createDeadline(killTimeoutMs, opts.signal))) {
    reapLockFile(pidPath)
    return { stopped: true, pid }
  }

  const escalated = signalTolerantly(pid, 'SIGKILL')
  if (escalated != null && !escalated.stopped) return escalated
  if (await pollUntilGone(pid, createDeadline(SIGKILL_GRACE_MS, opts.signal))) {
    reapLockFile(pidPath)
    return { stopped: true, pid }
  }
  return { stopped: false, pid, reason: 'timeout' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/process && pnpm exec vitest run test/status.test.ts`
Expected: PASS, 9 tests.

`daemon.test.ts` still references the old `getDaemonStatus` shape and will fail to typecheck. Delete its single `describe('getDaemonStatus', ...)` block now; Task 6 replaces the file.

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec biome check --write ./packages
git add packages/process/src/status.ts packages/process/test/status.test.ts \
  packages/process/test/daemon.test.ts
git commit -m "feat(process)!: pure async daemon status with an ESRCH/EPERM split"
```

---

### Task 6: runDaemon — the claim, the bind, the handle

This is where H3 closes. The largest task. Do not split the claim loop from the shutdown handle: the concurrent-boot test exercises both.

**Files:**
- Replace: `packages/process/src/daemon.ts` (`spawnDaemon` moves out, to Task 7)
- Replace: `packages/process/test/daemon.test.ts`
- Create: `packages/process/test/fixtures/protocol.ts`

**Interfaces:**
- Consumes: `DaemonAlreadyRunningError` (Task 2); `claimDaemonLock`, `DaemonLock`, `readLockRecord`, `reapLockFile` (Task 3); `isSocketLive`, `safeRemove` (Task 4); `classifyRecord`, `DEFAULT_BOOT_GRACE_MS` (Task 5); `getPIDPath`, `getSocketPath` (Task 1).
- Produces:
  - `type DaemonHandle = { pid: number; socketPath: string; pidPath: string; close(): Promise<void> }`
  - `type RunDaemonOptions<Protocol>` — today's fields plus `createTransport`, `handleSignals`, `shutdownTimeoutMs`, `signal`, `onError`, `bootGraceMs`
  - `function runDaemon<Protocol>(opts: RunDaemonOptions<Protocol>): Promise<DaemonHandle>`

`runDaemon`'s return type changes from `Promise<void>` to `Promise<DaemonHandle>` — source-compatible, since callers that ignore the value still typecheck.

`createTransport` is backlog item P1, folded in here because the connection handler is being rewritten anyway. Omitting it must reproduce today's behaviour exactly.

**Shutdown ordering matters.** `server.close()` stops accepting *and then waits for existing connections to drain*. Its callback never fires while a client is attached. So: call `server.close(cb)` first to stop accepting, destroy the tracked sockets immediately, and only then await the callback. Awaiting before destroying deadlocks.

- [ ] **Step 1: Write the failing test**

Create `packages/process/test/fixtures/protocol.ts`:

```ts
export const pingProtocol = {
  ping: { type: 'request', result: { type: 'string' } },
} as const

export type PingProtocol = typeof pingProtocol
```

Replace `packages/process/test/daemon.test.ts` entirely:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ClientMessage, ServerMessage, ServerTransportOf } from '@enkaku/protocol'
import { serve } from '@enkaku/server'
import { SocketTransport } from '@enkaku/socket'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type DaemonHandle, runDaemon, type RunDaemonOptions } from '../src/daemon.js'
import { DaemonAlreadyRunningError } from '../src/errors.js'
import { readLockRecord } from '../src/lock.js'
import { isSocketLive } from '../src/socket.js'
import type { PingProtocol } from './fixtures/protocol.js'

const APP = 'tejika-test'

let dir: string
let socketPath: string
let pidPath: string
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
  dir = mkdtempSync(join(tmpdir(), 'tejika-daemon-'))
  socketPath = join(dir, 'app.sock')
  pidPath = join(dir, 'app.pid')
})

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close().catch(() => {})))
  rmSync(dir, { recursive: true, force: true })
})

describe('runDaemon', () => {
  test('returns a handle and marks the lock ready', async () => {
    const handle = await boot()
    expect(handle.pid).toBe(process.pid)
    expect(handle.socketPath).toBe(socketPath)
    expect(handle.pidPath).toBe(pidPath)
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
    const record = readLockRecord(pidPath)
    expect(record?.ready).toBe(true)
    expect(record?.pid).toBe(process.pid)
  })

  test('refuses to boot beside a live daemon and leaves its socket alone', async () => {
    await boot()
    await expect(boot()).rejects.toBeInstanceOf(DaemonAlreadyRunningError)
    // The incumbent must survive untouched — this is the split-brain guarantee.
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
    expect(readLockRecord(pidPath)?.pid).toBe(process.pid)
  })

  test('two concurrent boots: exactly one wins, no live socket is unlinked', async () => {
    const results = await Promise.allSettled([boot(), boot()])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DaemonAlreadyRunningError)
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
  })

  test('reclaims a stale lockfile left by a dead process', async () => {
    // A pid far above any live process, so kill(pid, 0) yields ESRCH.
    writeFileSync(
      pidPath,
      JSON.stringify({ pid: 2 ** 22, socketPath, startedAt: Date.now(), ready: true }),
      'utf8',
    )
    const handle = await boot()
    expect(handle.pid).toBe(process.pid)
    expect(readLockRecord(pidPath)?.pid).toBe(process.pid)
  })

  test('reclaims a corrupt lockfile', async () => {
    writeFileSync(pidPath, 'garbage', 'utf8')
    await expect(boot()).resolves.toBeDefined()
    expect(readLockRecord(pidPath)?.pid).toBe(process.pid)
  })

  test('removes a stale socket file before binding', async () => {
    writeFileSync(socketPath, '', 'utf8')
    await expect(boot()).resolves.toBeDefined()
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
  })
})

describe('DaemonHandle.close', () => {
  test('removes the socket and the lockfile', async () => {
    const handle = await boot()
    await handle.close()
    await expect(isSocketLive(socketPath)).resolves.toBe(false)
    expect(readLockRecord(pidPath)).toBeNull()
  })

  test('is idempotent', async () => {
    const handle = await boot()
    await handle.close()
    await expect(handle.close()).resolves.toBeUndefined()
  })

  test('runs onShutdown only after the server stops accepting', async () => {
    let acceptingDuringShutdown: boolean | undefined
    const handle = await boot({
      onShutdown: async () => {
        acceptingDuringShutdown = await isSocketLive(socketPath)
      },
    })
    await handle.close()
    expect(acceptingDuringShutdown).toBe(false)
  })

  test('closes even while a client connection is open', async () => {
    const handle = await boot()
    const { connectSocket } = await import('@enkaku/socket')
    const client = await connectSocket(socketPath)
    // server.close() drains connections, so close() must destroy this socket
    // itself rather than waiting on it.
    await expect(handle.close()).resolves.toBeUndefined()
    client.destroy()
  })

  test('cleans up even when onShutdown rejects, and rethrows', async () => {
    const handle = await boot({
      onShutdown: async () => {
        throw new Error('cleanup exploded')
      },
    })
    await expect(handle.close()).rejects.toThrow('cleanup exploded')
    expect(readLockRecord(pidPath)).toBeNull()
    await expect(isSocketLive(socketPath)).resolves.toBe(false)
  })

  test('cleans up when onShutdown hangs past shutdownTimeoutMs', async () => {
    const handle = await boot({
      shutdownTimeoutMs: 50,
      onShutdown: () => new Promise<void>(() => {}),
    })
    await expect(handle.close()).rejects.toThrow(/timed out/i)
    expect(readLockRecord(pidPath)).toBeNull()
  })

  test('is triggered by an AbortSignal', async () => {
    const controller = new AbortController()
    await boot({ signal: controller.signal })
    controller.abort()
    await delay(200)
    await expect(isSocketLive(socketPath)).resolves.toBe(false)
    expect(readLockRecord(pidPath)).toBeNull()
  })
})

describe('connection handling', () => {
  test('a synchronously throwing serve kills one connection, not the daemon', async () => {
    const errors: Array<unknown> = []
    await boot({
      serve: () => {
        throw new Error('bad connection')
      },
      onError: (err) => errors.push(err),
    })
    const { connectSocket } = await import('@enkaku/socket')
    const client = await connectSocket(socketPath)
    await delay(50)
    client.destroy()
    expect(errors).toHaveLength(1)
    // The daemon must still be accepting.
    await expect(isSocketLive(socketPath)).resolves.toBe(true)
  })

  test('createTransport receives the raw socket and its transport is used', async () => {
    let sawSocket = false
    await boot({
      createTransport: (socket) => {
        sawSocket = true
        return new SocketTransport<ClientMessage, ServerMessage>({
          socket,
        }) as unknown as ServerTransportOf<PingProtocol>
      },
    })
    const { connectSocket } = await import('@enkaku/socket')
    const client = await connectSocket(socketPath)
    await delay(50)
    client.destroy()
    expect(sawSocket).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/process && pnpm exec vitest run test/daemon.test.ts`
Expected: FAIL — `runDaemon` resolves `undefined`; `handleSignals`, `pidPath`, `onError`, `createTransport` are not options.

- [ ] **Step 3: Write the implementation**

Replace `packages/process/src/daemon.ts` entirely:

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
import { getPIDPath, getSocketPath } from '@tejika/env'
import { DaemonAlreadyRunningError } from './errors.js'
import { claimDaemonLock, type DaemonLock, readLockRecord, reapLockFile } from './lock.js'
import { isSocketLive, safeRemove } from './socket.js'
import { classifyRecord, DEFAULT_BOOT_GRACE_MS } from './status.js'

const CLAIM_ATTEMPTS = 3
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000

export type RunDaemonOptions<Protocol extends ProtocolDefinition> = {
  app: string
  socketPath?: string
  pidPath?: string
  /** Build the Enkaku server for one accepted connection's transport. */
  serve: (transport: ServerTransportOf<Protocol>) => Server<Protocol>
  /**
   * Build the per-connection transport from the raw socket. Defaults to
   * `new SocketTransport({ socket })`. Lets a consumer wrap the connection
   * stream (e.g. sign messages) before the transport exists.
   */
  createTransport?: (socket: Socket) => ServerTransportOf<Protocol>
  /** Optional async cleanup, invoked after the server stops accepting. */
  onShutdown?: () => Promise<void>
  /** Install SIGTERM/SIGINT handlers that close, then exit. Default true. */
  handleSignals?: boolean
  /** Bound on `onShutdown`. Default 5000ms. */
  shutdownTimeoutMs?: number
  /** Aborting closes the daemon. */
  signal?: AbortSignal
  /** Post-boot server errors and per-connection `serve` failures. */
  onError?: (err: unknown) => void
  bootGraceMs?: number
}

export type DaemonHandle = {
  pid: number
  socketPath: string
  pidPath: string
  /** Idempotent: stop accepting, destroy connections, run onShutdown, clean up. */
  close(): Promise<void>
}

/**
 * Take the exclusive lock, reaping a stale one. Losers never unlink anything —
 * that is what closes the split-brain race: a process that did not win the
 * O_EXCL claim has no licence to touch the socket file.
 */
async function claimOrThrow(
  pidPath: string,
  socketPath: string,
  bootGraceMs: number,
): Promise<DaemonLock> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const result = claimDaemonLock(pidPath, {
      pid: process.pid,
      socketPath,
      startedAt: Date.now(),
      ready: false,
    })
    if ('lock' in result) return result.lock

    const status = await classifyRecord(result.conflict, { bootGraceMs, now: Date.now() })
    if (status.state !== 'stale' && status.state !== 'not-running') {
      throw new DaemonAlreadyRunningError(status.pid, socketPath)
    }
    // Stale (or corrupt): reap and retry. The reap is inode-guarded; a racer who
    // claims between our read and our reap is protected by its own markReady
    // rewrite plus the live-socket check below.
    reapLockFile(pidPath)
  }
  throw new DaemonAlreadyRunningError(readLockRecord(pidPath)?.pid ?? -1, socketPath)
}

async function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`onShutdown timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
  })
  try {
    await Promise.race([work, timeout])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

/**
 * Stop accepting, then destroy live connections so `close()` can settle.
 * `server.close()` drains existing connections before firing its callback, so
 * destroying must happen after the call and before the await, or a connected
 * client wedges shutdown forever.
 */
async function closeServer(server: NetServer, connections: Set<Socket>): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((err) => (err == null ? resolve() : reject(err)))
  })
  for (const socket of connections) socket.destroy()
  connections.clear()
  await closed
}

/**
 * Boot a daemon in the current process. Claims an exclusive lock BEFORE binding,
 * so two concurrent boots cannot both pass a liveness check and unlink each
 * other's socket. Returns a handle; signal handlers are installed by default.
 */
export async function runDaemon<Protocol extends ProtocolDefinition>(
  opts: RunDaemonOptions<Protocol>,
): Promise<DaemonHandle> {
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  const pidPath = opts.pidPath ?? getPIDPath(opts.app)
  const shutdownTimeoutMs = opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const handleSignals = opts.handleSignals !== false

  // 0o700 before the bind: the socket is unreachable during the window between
  // listen() and chmod(), rather than briefly world-accessible.
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
  mkdirSync(dirname(pidPath), { recursive: true, mode: 0o700 })

  const lock = await claimOrThrow(pidPath, socketPath, opts.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS)

  if (existsSync(socketPath)) {
    if (await isSocketLive(socketPath)) {
      // A foreign daemon holds the socket without a lockfile. We hold the lock,
      // but its socket is not ours to steal.
      lock.release()
      throw new DaemonAlreadyRunningError(-1, socketPath)
    }
    safeRemove(socketPath)
  }

  const connections = new Set<Socket>()
  const server = createServer((socket) => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
    try {
      const transport =
        opts.createTransport?.(socket) ??
        (new SocketTransport<ClientMessage, ServerMessage>({
          socket,
        }) as unknown as ServerTransportOf<Protocol>)
      const handler = opts.serve(transport)
      socket.once('close', () => void handler.dispose())
    } catch (err) {
      // One bad connection must not take the daemon down.
      opts.onError?.(err)
      socket.destroy()
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600)
      resolve()
    })
  })
  // The boot promise has settled; its `reject` would be a no-op for later errors.
  server.removeAllListeners('error')
  server.on('error', (err) => opts.onError?.(err))

  lock.markReady()

  let closing: Promise<void> | undefined

  // Declared before `close` so the handler is in scope when `close` removes it.
  const onSignal = (): void => {
    void close().then(
      () => process.exit(0),
      (err) => {
        console.error(err)
        process.exit(1)
      },
    )
  }

  const close = async (): Promise<void> => {
    if (closing != null) return await closing
    closing = (async (): Promise<void> => {
      if (handleSignals) {
        process.off('SIGTERM', onSignal)
        process.off('SIGINT', onSignal)
      }
      try {
        await closeServer(server, connections)
        if (opts.onShutdown != null) await withTimeout(opts.onShutdown(), shutdownTimeoutMs)
      } finally {
        // Always: a rejected or timed-out onShutdown must not leak the socket
        // file or the lock.
        safeRemove(socketPath)
        lock.release()
      }
    })()
    return await closing
  }

  if (handleSignals) {
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
  }
  opts.signal?.addEventListener('abort', () => void close().catch((err) => opts.onError?.(err)), {
    once: true,
  })

  return { pid: process.pid, socketPath, pidPath, close }
}
```

`onSignal` references `close` before its `const` initialiser runs, but only when a signal actually fires — by which time `runDaemon` has returned and `close` is initialised. `close` references `onSignal`, which is initialised first. No temporal dead zone is hit at runtime.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/process && pnpm exec vitest run test/daemon.test.ts`
Expected: PASS, 14 tests.

The concurrent-boot test is the acceptance criterion for H3. If it is flaky, the claim loop is wrong — fix the loop, do not add retries to the test.

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec biome check --write ./packages
git add packages/process/src/daemon.ts packages/process/test/daemon.test.ts \
  packages/process/test/fixtures/protocol.ts
git commit -m "feat(process)!: close the split-brain boot race with an exclusive claim"
```

---

### Task 7: spawnDaemon — boot-crash surfacing

**Files:**
- Create: `packages/process/src/spawn.ts`
- Create: `packages/process/test/spawn.test.ts`
- Create: `packages/process/test/fixtures/crash-entry.ts`
- Replace: `packages/process/test/fixtures/daemon-entry.ts`

**Interfaces:**
- Consumes: `DaemonBootError` (Task 2); `Deadline`, `createDeadline`, `waitForSocket` (Task 4).
- Produces:
  - `type SpawnDaemonOptions = { app: string; entry: string; args?: Array<string>; socketPath?: string; pidPath?: string; logPath?: string; env?: Record<string, string>; timeoutMs?: number; deadline?: Deadline; signal?: AbortSignal }`
  - `function spawnDaemon(opts: SpawnDaemonOptions): Promise<void>`

`pidPath` is forwarded to the entry as `--pid-path <path>`, mirroring `--socket-path`. That closes the audit's "`EnsureDaemonOptions` lacks `logPath`/`pidPath` passthrough" finding, and lets tests keep the daemon off the real state dir without env-var overrides.

`env` is passed to `nano-spawn`, which merges it over `process.env` rather than replacing it. That is what lets tests inject `NODE_OPTIONS=--import tsx` into the child without mutating their own process — the test-hygiene finding.

- [ ] **Step 1: Write the failing test**

Create `packages/process/test/fixtures/crash-entry.ts`:

```ts
// A daemon entry that dies during boot, before binding its socket.
console.error('boom: could not initialise')
process.exit(3)
```

Replace `packages/process/test/fixtures/daemon-entry.ts`:

```ts
import { parseArgs } from 'node:util'
import { serve } from '@enkaku/server'
import { runDaemon } from '../../src/index.js'

// Run with `node --import tsx` so the spawned process executes this TypeScript
// directly. `--pid-path` keeps the daemon off the real state dir.
const { values } = parseArgs({
  options: { 'socket-path': { type: 'string' }, 'pid-path': { type: 'string' } },
  strict: false,
})

const protocol = { ping: { type: 'request', result: { type: 'string' } } } as const

await runDaemon<typeof protocol>({
  app: 'tejika-test',
  socketPath: values['socket-path'] as string,
  pidPath: values['pid-path'] as string,
  serve: (transport) =>
    serve<typeof protocol>({ requireAuth: false, handlers: { ping: () => 'pong' }, transport }),
})
```

Create `packages/process/test/spawn.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DaemonBootError } from '../src/errors.js'
import { spawnDaemon } from '../src/spawn.js'
import { stopDaemon } from '../src/status.js'

const APP = 'tejika-test'
const daemonEntry = fileURLToPath(new URL('./fixtures/daemon-entry.ts', import.meta.url))
const crashEntry = fileURLToPath(new URL('./fixtures/crash-entry.ts', import.meta.url))

// nano-spawn merges `env` over process.env, so the child gets tsx without this
// process having to mutate its own NODE_OPTIONS.
const env = { NODE_OPTIONS: '--import tsx' }

let dir: string
let socketPath: string
let pidPath: string
let logPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-spawn-'))
  socketPath = join(dir, 'app.sock')
  pidPath = join(dir, 'app.pid')
  logPath = join(dir, 'daemon.log')
})

afterEach(async () => {
  await stopDaemon({ app: APP, pidPath }).catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

test('spawns a daemon and resolves once its socket accepts', { timeout: 30_000 }, async () => {
  await spawnDaemon({ app: APP, entry: daemonEntry, socketPath, pidPath, logPath, env, timeoutMs: 20_000 })
  const record = JSON.parse(readFileSync(pidPath, 'utf8')) as { ready: boolean; pid: number }
  expect(record.ready).toBe(true)
  expect(record.pid).toBeGreaterThan(0)
})

test('surfaces a boot crash before the socket-wait timeout', { timeout: 30_000 }, async () => {
  const started = Date.now()
  const error = await spawnDaemon({
    app: APP,
    entry: crashEntry,
    socketPath,
    logPath,
    env,
    // A long budget: the point is that we fail fast on the child's exit rather
    // than burning this timeout.
    timeoutMs: 20_000,
  }).catch((err: unknown) => err)

  expect(error).toBeInstanceOf(DaemonBootError)
  expect((error as DaemonBootError).logPath).toBe(logPath)
  expect((error as DaemonBootError).message).toContain(logPath)
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(readFileSync(logPath, 'utf8')).toContain('boom')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/process && pnpm exec vitest run test/spawn.test.ts`
Expected: FAIL with `Failed to resolve import "../src/spawn.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/process/src/spawn.ts`:

```ts
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getDataDir, getSocketPath } from '@tejika/env'
import spawn from 'nano-spawn'
import { createDeadline, type Deadline } from './deadline.js'
import { DaemonBootError } from './errors.js'
import { waitForSocket } from './socket.js'

export type SpawnDaemonOptions = {
  app: string
  /** Entry script run with `node`. Receives `--socket-path <path>`, and `--pid-path <path>` when given. */
  entry: string
  args?: Array<string>
  socketPath?: string
  pidPath?: string
  logPath?: string
  /** Merged over `process.env` for the child. */
  env?: Record<string, string>
  /** Budget for the socket wait. Ignored when `deadline` is given. Default 3000ms. */
  timeoutMs?: number
  deadline?: Deadline
  signal?: AbortSignal
}

/**
 * Spawn the detached daemon and wait until its socket accepts connections.
 * The wait races the child's exit, so a boot crash surfaces the child's error
 * and a pointer to `logPath` immediately rather than after the full timeout.
 */
export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<void> {
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  const logPath = opts.logPath ?? join(getDataDir(opts.app), 'daemon.log')
  const deadline = opts.deadline ?? createDeadline(opts.timeoutMs ?? 3000, opts.signal)

  mkdirSync(dirname(logPath), { recursive: true })
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })

  const args = [opts.entry, '--socket-path', socketPath]
  if (opts.pidPath != null) args.push('--pid-path', opts.pidPath)
  if (opts.args != null) args.push(...opts.args)

  const logFD = openSync(logPath, 'a')
  const subprocess = spawn('node', args, {
    detached: true,
    stdio: ['ignore', logFD, logFD],
    env: opts.env,
  })

  // The child outlives us; its promise settles only if it dies. Racing it against
  // the socket wait turns a boot crash into an immediate, specific error rather
  // than an opaque timeout.
  const exited: Promise<never> = subprocess.then(
    (result) => {
      throw new DaemonBootError('daemon exited during boot', { logPath, cause: result })
    },
    (cause: unknown) => {
      throw new DaemonBootError('daemon failed to start', { logPath, cause })
    },
  )

  try {
    // Dereference the child so it can outlive us.
    const child = await subprocess.nodeChildProcess
    child.unref()
  } finally {
    // The child holds its own copy of the descriptor; release ours.
    closeSync(logFD)
  }

  try {
    await Promise.race([waitForSocket(socketPath, { deadline }), exited])
  } finally {
    // Once the race settles, the loser must not become an unhandled rejection.
    exited.catch(() => {})
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/process && pnpm exec vitest run test/spawn.test.ts`
Expected: PASS, 2 tests. The crash test must finish well under 10s — that is the acceptance criterion for the boot-crash finding.

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec biome check --write ./packages
git add packages/process/src/spawn.ts packages/process/test/spawn.test.ts \
  packages/process/test/fixtures/crash-entry.ts packages/process/test/fixtures/daemon-entry.ts
git commit -m "feat(process): surface daemon boot crashes instead of timing out"
```

---

### Task 8: createDaemonTransport — the client seam and hardened reconnect

**Files:**
- Replace: `packages/process/src/client.ts`
- Create: `packages/process/test/client.test.ts`

**Interfaces:**
- Consumes: `getSocketPath` (Task 1).
- Produces:
  - `type CreateDaemonClientOptions = { app: string; socketPath?: string; signal?: AbortSignal; connectTimeoutMs?: number }`
  - `type DaemonTransport<Protocol> = { transport: ClientTransportOf<Protocol>; handleTransportDisposed: () => ClientTransportOf<Protocol> | undefined; handleTransportError: () => ClientTransportOf<Protocol> | undefined; dispose: () => void }`
  - `function createDaemonTransport<Protocol>(opts: CreateDaemonClientOptions): Promise<DaemonTransport<Protocol>>`
  - `function createDaemonClient<Protocol>(opts: CreateDaemonClientOptions): Promise<Client<Protocol>>` — signature unchanged
  - `function nextBackoff(current: number, random?: () => number): number` — exported for tests

Enkaku's `ClientParams` types these hooks as `handleTransportDisposed?: (signal: AbortSignal) => ClientTransportOf<Protocol> | void` and `handleTransportError?: (error: Error) => ClientTransportOf<Protocol> | void`. Zero-argument functions returning `| undefined` are assignable to both, so `DaemonTransport`'s simpler shape works unchanged.

This is backlog item P2. `createDaemonClient` keeps its exact signature and behaviour, implemented over the seam.

Reconnect changes: full jitter, and a backoff that resets only after a connection has stayed open for 2000ms rather than on a raw TCP connect. An accept-then-crash daemon otherwise churns at 250ms forever.

`nextBackoff(current, random)` returns `random() * ceiling`, where `ceiling` is `250` when `current` is `0`, and `min(current * 2, 5000)` otherwise. With `random = () => 1` the sequence from `0` is `250, 500, 1000, 2000, 4000, 5000, 5000, …`.

- [ ] **Step 1: Write the failing test**

Create `packages/process/test/client.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createDaemonTransport, nextBackoff } from '../src/client.js'
import type { PingProtocol } from './fixtures/protocol.js'

const RECONNECT_MAX_MS = 5000

describe('nextBackoff', () => {
  test('the first backoff is a jittered value inside the base window', () => {
    expect(nextBackoff(0, () => 1)).toBe(250)
    expect(nextBackoff(0, () => 0.5)).toBe(125)
    expect(nextBackoff(0, () => 0)).toBe(0)
  })

  test('doubles the ceiling each time and caps it', () => {
    const top = () => 1
    const seen = [nextBackoff(0, top)]
    for (let i = 0; i < 7; i++) seen.push(nextBackoff(seen[seen.length - 1] as number, top))
    expect(seen.slice(0, 6)).toEqual([250, 500, 1000, 2000, 4000, 5000])
    expect(Math.max(...seen)).toBeLessThanOrEqual(RECONNECT_MAX_MS)
  })

  test('never returns a negative or NaN value', () => {
    for (const random of [0, 0.5, 1]) {
      const value = nextBackoff(1000, () => random)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(Number.isNaN(value)).toBe(false)
    }
  })
})

describe('createDaemonTransport', () => {
  let dir: string
  let socketPath: string
  let server: Server | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tejika-client-'))
    socketPath = join(dir, 'app.sock')
  })

  afterEach(async () => {
    if (server != null) await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  test('throws when nothing is listening', async () => {
    await expect(
      createDaemonTransport<PingProtocol>({ app: 'tejika-test', socketPath }),
    ).rejects.toThrow()
  })

  test('exposes the three Client hooks plus dispose', async () => {
    server = createServer()
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve))

    const daemonTransport = await createDaemonTransport<PingProtocol>({
      app: 'tejika-test',
      socketPath,
    })
    expect(daemonTransport.transport).toBeDefined()
    expect(typeof daemonTransport.handleTransportDisposed).toBe('function')
    expect(typeof daemonTransport.handleTransportError).toBe('function')

    // After dispose the hooks must stop handing out fresh transports, or
    // shutdown races a reconnect.
    daemonTransport.dispose()
    expect(daemonTransport.handleTransportDisposed()).toBeUndefined()
    expect(daemonTransport.handleTransportError()).toBeUndefined()
  })

  test('rejects promptly rather than hanging when the socket is absent', async () => {
    const started = Date.now()
    await expect(
      createDaemonTransport<PingProtocol>({
        app: 'tejika-test',
        socketPath,
        connectTimeoutMs: 200,
      }),
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/process && pnpm exec vitest run test/client.test.ts`
Expected: FAIL — `createDaemonTransport` and `nextBackoff` are not exported from `client.ts`.

- [ ] **Step 3: Write the implementation**

Replace `packages/process/src/client.ts` entirely:

```ts
import type { Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@enkaku/client'
import type {
  ClientMessage,
  ClientTransportOf,
  ProtocolDefinition,
  ServerMessage,
} from '@enkaku/protocol'
import { connectSocket, SocketTransport } from '@enkaku/socket'
import { getSocketPath } from '@tejika/env'

/** Reconnect backoff bounds: start fast, cap at a few seconds. */
const RECONNECT_BASE_MS = 250
const RECONNECT_MAX_MS = 5000
/** A connection must stay open this long before the backoff resets. */
const RECONNECT_STABLE_MS = 2000
const DEFAULT_CONNECT_TIMEOUT_MS = 5000

export type CreateDaemonClientOptions = {
  app: string
  socketPath?: string
  /** Aborting stops reconnection. */
  signal?: AbortSignal
  /** Bound on each connect attempt. Default 5000ms. */
  connectTimeoutMs?: number
}

/**
 * Full jitter: a uniform random value in `[0, ceiling)`. Without jitter, every
 * client of a restarted daemon reconnects in lockstep.
 */
export function nextBackoff(current: number, random: () => number = Math.random): number {
  const ceiling = current === 0 ? RECONNECT_BASE_MS : Math.min(current * 2, RECONNECT_MAX_MS)
  return random() * ceiling
}

/**
 * Connect, but never hang: Enkaku's `connectSocket` has no timeout of its own.
 * On timeout the still-pending connect is destroyed when it eventually settles,
 * so no socket leaks. (Upstream fix filed; this is the local mitigation.)
 */
async function connectWithTimeout(socketPath: string, timeoutMs: number): Promise<Socket> {
  const pending = connectSocket(socketPath)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void pending.then((socket) => socket.destroy()).catch(() => {})
      reject(new Error(`Timed out connecting to ${socketPath}`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

export type DaemonTransport<Protocol extends ProtocolDefinition> = {
  transport: ClientTransportOf<Protocol>
  handleTransportDisposed: () => ClientTransportOf<Protocol> | undefined
  handleTransportError: () => ClientTransportOf<Protocol> | undefined
  /** Abort reconnection; wire to the owning client's `disposing` event. */
  dispose: () => void
}

/**
 * The reconnect machinery, extracted from `createDaemonClient` so a consumer with
 * its own `Client` subtype can reuse it. Throws on the INITIAL connect if the
 * socket is absent or refused, so `ensureDaemon` can spawn the daemon; once
 * connected, later drops are healed transparently.
 */
export async function createDaemonTransport<Protocol extends ProtocolDefinition>(
  opts: CreateDaemonClientOptions,
): Promise<DaemonTransport<Protocol>> {
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const firstSocket = await connectWithTimeout(socketPath, connectTimeoutMs)

  let backoffMs = 0
  // Aborted on dispose: cancels an in-flight backoff and stops the next reconnect,
  // so shutdown never opens a fresh socket after teardown.
  const shutdown = new AbortController()
  opts.signal?.addEventListener('abort', () => shutdown.abort(), { once: true })

  // A clean peer close yields a done-read in the client, which fires no reconnect
  // hook — so the transport is forced to dispose when its socket closes, routing
  // every drop through `handleTransportDisposed`.
  const firstTransport = new SocketTransport<ServerMessage, ClientMessage>({ socket: firstSocket })
  firstSocket.once('close', () => void firstTransport.dispose())

  const reconnectingTransport = (): SocketTransport<ServerMessage, ClientMessage> => {
    let self: SocketTransport<ServerMessage, ClientMessage>
    const source = async (): Promise<Socket> => {
      if (backoffMs > 0) await delay(backoffMs, undefined, { signal: shutdown.signal })
      const socket = await connectWithTimeout(socketPath, connectTimeoutMs)
      if (shutdown.signal.aborted) {
        socket.destroy()
        throw new Error('daemon client disposed')
      }
      // Reset only once the connection has PROVEN stable. Resetting on connect
      // lets an accept-then-crash daemon churn at the base delay forever.
      const stable = setTimeout(() => {
        backoffMs = 0
      }, RECONNECT_STABLE_MS)
      stable.unref()
      socket.once('close', () => {
        clearTimeout(stable)
        void self.dispose()
      })
      return socket
    }
    self = new SocketTransport<ServerMessage, ClientMessage>({ socket: source })
    return self
  }

  // Both the disposed (clean close) and error (failed reconnect) paths reconnect.
  // During shutdown, return nothing so the client tears down instead.
  const nextTransport = (): ClientTransportOf<Protocol> | undefined => {
    if (shutdown.signal.aborted) return undefined
    backoffMs = nextBackoff(backoffMs)
    return reconnectingTransport() as unknown as ClientTransportOf<Protocol>
  }

  return {
    transport: firstTransport as unknown as ClientTransportOf<Protocol>,
    handleTransportDisposed: nextTransport,
    handleTransportError: nextTransport,
    dispose: () => shutdown.abort(),
  }
}

/**
 * Connect an Enkaku `Client` to a running daemon, reconnecting automatically if
 * the daemon socket drops. A thin wrapper over `createDaemonTransport`.
 */
export async function createDaemonClient<Protocol extends ProtocolDefinition>(
  opts: CreateDaemonClientOptions,
): Promise<Client<Protocol>> {
  const { transport, handleTransportDisposed, handleTransportError, dispose } =
    await createDaemonTransport<Protocol>(opts)

  const client = new Client<Protocol>({ transport, handleTransportDisposed, handleTransportError })
  // Stop reconnecting before the client aborts its transport on dispose.
  client.events.on('disposing', () => dispose())
  return client
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/process && pnpm exec vitest run test/client.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec biome check --write ./packages
git add packages/process/src/client.ts packages/process/test/client.test.ts
git commit -m "feat(process): extract createDaemonTransport, jitter and stabilise reconnect"
```

---

### Task 9: ensureDaemon — one budget for the whole call

**Files:**
- Replace: `packages/process/src/controller.ts`
- Create: `packages/process/test/controller.test.ts`
- Create: `packages/process/test/fixtures/hang-entry.ts`

**Interfaces:**
- Consumes: `createDeadline`, `Deadline`, `probeSocket`, `safeRemove` (Task 4); `spawnDaemon` (Task 7); `createDaemonClient` (Task 8).
- Produces:
  - `type EnsureDaemonOptions = { app: string; entry: string; args?: Array<string>; socketPath?: string; pidPath?: string; logPath?: string; env?: Record<string, string>; timeoutMs?: number; intervalMs?: number; connectTimeoutMs?: number; signal?: AbortSignal }`
  - `function ensureDaemon<Protocol>(opts: EnsureDaemonOptions): Promise<Client<Protocol>>`

`timeoutMs` now bounds the **entire** operation — the initial connect, the spawn, the socket wait, and the connect retries — and defaults to `10_000`. Previously `spawnDaemon` hardcoded a 3000ms socket wait while `timeoutMs` governed only `connectWithRetry`, so the two did not compose.

Only remove a socket file on `ECONNREFUSED` **and** a `'dead'` probe. `'forbidden'` means another user's daemon is listening on it.

- [ ] **Step 1: Write the failing test**

Create `packages/process/test/fixtures/hang-entry.ts`:

```ts
// A daemon entry that starts, never binds a socket, and never exits.
setInterval(() => {}, 1_000)
```

Create `packages/process/test/controller.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ensureDaemon } from '../src/controller.js'
import { stopDaemon } from '../src/status.js'
import type { PingProtocol } from './fixtures/protocol.js'

const APP = 'tejika-test'
const entry = fileURLToPath(new URL('./fixtures/daemon-entry.ts', import.meta.url))
const hangEntry = fileURLToPath(new URL('./fixtures/hang-entry.ts', import.meta.url))
const env = { NODE_OPTIONS: '--import tsx' }

let dir: string
let socketPath: string
let pidPath: string
let logPath: string

const options = () => ({
  app: APP,
  entry,
  socketPath,
  pidPath,
  logPath,
  env,
  timeoutMs: 20_000,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-controller-'))
  socketPath = join(dir, 'app.sock')
  pidPath = join(dir, 'app.pid')
  logPath = join(dir, 'daemon.log')
})

afterEach(async () => {
  await stopDaemon({ app: APP, pidPath }).catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

test('spawns a daemon and returns a working client', { timeout: 30_000 }, async () => {
  const client = await ensureDaemon<PingProtocol>(options())
  await expect(client.request('ping')).resolves.toBe('pong')
  await client.dispose()
})

test('clears a stale socket file and boots anyway', { timeout: 30_000 }, async () => {
  writeFileSync(socketPath, '', 'utf8')
  const client = await ensureDaemon<PingProtocol>(options())
  await expect(client.request('ping')).resolves.toBe('pong')
  await client.dispose()
})

test('timeoutMs bounds the whole call, not just the connect retries', { timeout: 30_000 }, async () => {
  const started = Date.now()
  await expect(
    ensureDaemon<PingProtocol>({ ...options(), entry: hangEntry, timeoutMs: 1500 }),
  ).rejects.toThrow()
  // Previously this took 3000ms (socket wait) + 5000ms (connect retry).
  expect(Date.now() - started).toBeLessThan(4000)
})

test('an aborted signal rejects promptly', { timeout: 30_000 }, async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  await expect(
    ensureDaemon<PingProtocol>({ ...options(), entry: hangEntry, signal: controller.signal }),
  ).rejects.toThrow()
})

// Ported from the deleted spawn.integration.test.ts: the reconnect path is
// covered nowhere else.
test('the client reconnects after the daemon is SIGKILLed and revived', { timeout: 60_000 }, async () => {
  const client = await ensureDaemon<PingProtocol>(options())
  await expect(client.request('ping')).resolves.toBe('pong')

  const { pid } = JSON.parse(readFileSync(pidPath, 'utf8')) as { pid: number }
  process.kill(pid, 'SIGKILL')
  await delay(500)

  const revived = await ensureDaemon<PingProtocol>(options())

  let reconnected = false
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      if ((await client.request('ping')) === 'pong') {
        reconnected = true
        break
      }
    } catch {
      // mid-reconnect: the in-flight request aborts; keep polling.
    }
    await delay(250)
  }
  expect(reconnected).toBe(true)

  await client.dispose()
  await revived.dispose()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/process && pnpm exec vitest run test/controller.test.ts`
Expected: FAIL — `pidPath`, `logPath`, `env`, and `signal` are not options on `EnsureDaemonOptions`.

- [ ] **Step 3: Write the implementation**

Replace `packages/process/src/controller.ts` entirely:

```ts
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import type { Client } from '@enkaku/client'
import type { ProtocolDefinition } from '@enkaku/protocol'
import { getSocketPath } from '@tejika/env'
import { createDaemonClient } from './client.js'
import { createDeadline, type Deadline } from './deadline.js'
import { probeSocket, safeRemove } from './socket.js'
import { spawnDaemon } from './spawn.js'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_CONNECT_TIMEOUT_MS = 1000

export type EnsureDaemonOptions = {
  app: string
  /** Daemon entry script spawned when no daemon is reachable. */
  entry: string
  args?: Array<string>
  socketPath?: string
  pidPath?: string
  logPath?: string
  /** Merged over `process.env` for the spawned daemon. */
  env?: Record<string, string>
  /** Total budget for the WHOLE call: connect, spawn, socket wait, retries. Default 10000ms. */
  timeoutMs?: number
  /** Delay between connect attempts. Default 50ms. */
  intervalMs?: number
  /** Bound on each individual connect attempt. Default 1000ms. */
  connectTimeoutMs?: number
  signal?: AbortSignal
}

const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOENT'])

function isConnectError(err: unknown): boolean {
  return CONNECT_CODES.has((err as NodeJS.ErrnoException).code ?? '')
}

async function connectWithRetry<Protocol extends ProtocolDefinition>(
  opts: EnsureDaemonOptions,
  socketPath: string,
  deadline: Deadline,
): Promise<Client<Protocol>> {
  const intervalMs = opts.intervalMs ?? 50
  let lastError: unknown
  for (;;) {
    try {
      return await createDaemonClient<Protocol>({
        app: opts.app,
        socketPath,
        connectTimeoutMs: opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        signal: deadline.signal,
      })
    } catch (err) {
      if (!isConnectError(err)) throw err
      lastError = err
      if (deadline.expired()) throw lastError
      await delay(Math.min(intervalMs, deadline.remaining()), undefined, {
        signal: deadline.signal,
      })
    }
  }
}

/**
 * Ensure a daemon is running and return a connected client. `timeoutMs` bounds
 * the whole operation: the budget is threaded through the spawn's socket wait
 * and the connect retries rather than each imposing its own.
 */
export async function ensureDaemon<Protocol extends ProtocolDefinition>(
  opts: EnsureDaemonOptions,
): Promise<Client<Protocol>> {
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  const deadline = createDeadline(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal)
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS

  try {
    return await createDaemonClient<Protocol>({
      app: opts.app,
      socketPath,
      connectTimeoutMs,
      signal: deadline.signal,
    })
  } catch (err) {
    if (!isConnectError(err)) throw err

    // A refused connection on an existing socket file means a stale socket from a
    // crashed daemon. `forbidden` means another user's daemon is listening on it —
    // never unlink that.
    if (existsSync(socketPath) && (await probeSocket(socketPath)) === 'dead') {
      safeRemove(socketPath)
    }

    await spawnDaemon({
      app: opts.app,
      entry: opts.entry,
      args: opts.args,
      socketPath,
      pidPath: opts.pidPath,
      logPath: opts.logPath,
      env: opts.env,
      deadline,
    })
    return await connectWithRetry<Protocol>(opts, socketPath, deadline)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/process && pnpm exec vitest run test/controller.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec biome check --write ./packages
git add packages/process/src/controller.ts packages/process/test/controller.test.ts \
  packages/process/test/fixtures/hang-entry.ts
git commit -m "feat(process)!: compose one timeout budget across ensureDaemon"
```

---

### Task 10: Public exports, and delete the superseded integration test

**Files:**
- Replace: `packages/process/src/index.ts`
- Delete: `packages/process/test/spawn.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: the package's public surface.

`classifyRecord`, `StatusDeps`, `reapLockFile`, `claimDaemonLock`, and `nextBackoff` are **not** exported from the index — they are internals that tests import from `../src/` directly.

`spawn.integration.test.ts` is now fully superseded: its spawn and ping assertions live in `controller.test.ts` and `spawn.test.ts`, and its SIGKILL/revive/reconnect case was ported into `controller.test.ts` in Task 9. Confirm that port exists before deleting.

- [ ] **Step 1: Confirm the reconnect case was ported**

Read `packages/process/test/controller.test.ts` and verify it contains the test named "the client reconnects after the daemon is SIGKILLed and revived". If it does not, stop and port it from `spawn.integration.test.ts` first — that behaviour is covered nowhere else.

- [ ] **Step 2: Replace the index**

```ts
export {
  createDaemonClient,
  createDaemonTransport,
  type CreateDaemonClientOptions,
  type DaemonTransport,
} from './client.js'
export { type EnsureDaemonOptions, ensureDaemon } from './controller.js'
export { type DaemonHandle, type RunDaemonOptions, runDaemon } from './daemon.js'
export { createDeadline, type Deadline } from './deadline.js'
export { DaemonAlreadyRunningError, DaemonBootError } from './errors.js'
export type { LockRecord } from './lock.js'
export { isSocketLive, probeSocket, type SocketProbe, waitForSocket } from './socket.js'
export { type SpawnDaemonOptions, spawnDaemon } from './spawn.js'
export {
  type DaemonStatus,
  getDaemonStatus,
  type StopDaemonOptions,
  type StopResult,
  stopDaemon,
} from './status.js'
```

- [ ] **Step 3: Delete the superseded test and verify the package**

```bash
git rm packages/process/test/spawn.integration.test.ts
cd packages/process && pnpm exec tsc --noEmit --skipLibCheck && pnpm exec vitest run
```

Expected: typecheck clean; every `packages/process` test green. Confirm nothing under `packages/process/test/` still assigns `process.env.NODE_OPTIONS` or `process.env.TEJIKA_TEST_PID_PATH` — that was the test-hygiene finding.

- [ ] **Step 4: Commit**

```bash
pnpm exec biome check --write ./packages
git add packages/process/src/index.ts
git commit -m "feat(process)!: publish the new daemon surface"
```

---

### Task 11: Update `@tejika/test` for the async status union

**Files:**
- Modify: `packages/test/src/daemon.ts`
- Modify: `packages/test/test/daemon.test.ts`
- Modify: `packages/test/test/daemon-lifecycle.integration.test.ts:5,19,33,35`
- Modify: `packages/test/test/fixtures/daemon-entry.js:2,7`

**Interfaces:**
- Consumes: `getDaemonStatus`, `DaemonStatus` (Task 5); `runDaemon` (Task 6).
- Produces: `waitForDaemonRunning`, `waitForDaemonStopped` — signatures unchanged.

`poll` already accepts an async predicate (`fn: () => T | Promise<T>`), so only the callbacks change.

Two semantic points. `waitForDaemonRunning` must treat `booting` as **not yet running** and wait for `state === 'running'`, or a test proceeds against a daemon whose socket has not bound. And the existing doc comment — "Daemons write their pidfile only after their socket accepts connections" — is now **false**: under claim-before-bind the lockfile appears first, with `ready: false`. Rewrite it.

`daemon-lifecycle.integration.test.ts:35` reads `getDaemonStatus({ app: APP, pidPath }).running` synchronously; it needs `await` and `.state === 'running'`.

- [ ] **Step 1: Update the implementation**

Replace the two function bodies in `packages/test/src/daemon.ts`:

```ts
/**
 * Poll until the daemon reports `running`; resolve its pid. Throws on timeout:
 * an assertion that never sees the daemon running must fail loudly.
 * A daemon claims its lockfile BEFORE binding its socket, so a record on disk is
 * not proof of readiness — `booting` is deliberately not accepted here.
 */
export async function waitForDaemonRunning(options: WaitForDaemonOptions): Promise<number> {
  const { pidPath, timeoutMs = 5_000, intervalMs = 100 } = options
  const pid = await poll(
    async () => {
      // `app` is unused by getDaemonStatus when pidPath is explicit.
      const status = await getDaemonStatus({ app: '', pidPath })
      return status.state === 'running' ? status.pid : undefined
    },
    { timeoutMs, intervalMs },
  )
  if (pid == null) {
    throw new Error(`daemon did not report running within ${timeoutMs}ms (pidfile: ${pidPath})`)
  }
  return pid
}

/**
 * Poll until the lockfile is gone or names a dead process. Returns on timeout
 * instead of throwing: teardown tolerates a stuck daemon.
 */
export async function waitForDaemonStopped(options: WaitForDaemonOptions): Promise<void> {
  const { pidPath, timeoutMs = 5_000, intervalMs = 100 } = options
  await poll(
    async () => {
      const status = await getDaemonStatus({ app: '', pidPath })
      return status.state === 'not-running' || status.state === 'stale'
    },
    { timeoutMs, intervalMs },
  )
}
```

- [ ] **Step 2: Update the tests**

In `packages/test/test/daemon.test.ts`, every place that writes a bare-integer pidfile must write a JSON `LockRecord`. A `ready: true` record whose `socketPath` has no listener classifies as **stale**, not running — so a test asserting "running" must either point `socketPath` at a live listener, or use `ready: false` with a fresh `startedAt` to land in `booting`. Read each test, decide what it means, and make it explicit. Example of a running record backed by a real listener:

```ts
import { createServer } from 'node:net'
// ...
const server = createServer()
await new Promise<void>((resolve) => server.listen(socketPath, resolve))
writeFileSync(
  pidPath,
  JSON.stringify({ pid: process.pid, socketPath, startedAt: Date.now(), ready: true }),
  'utf8',
)
```

In `packages/test/test/daemon-lifecycle.integration.test.ts`, change line 35's `getDaemonStatus({ app: APP, pidPath }).running` to `(await getDaemonStatus({ app: APP, pidPath })).state === 'running'`, and update the `stopDaemon` calls on lines 19 and 33 — they now resolve a `StopResult` rather than `void`, which is source-compatible unless the result is asserted on.

In `packages/test/test/fixtures/daemon-entry.js`, `runDaemon` now resolves a handle. No change is required unless the fixture asserts on the return value; verify and leave it alone if not.

- [ ] **Step 3: Run the full suite**

Run: `rtk proxy pnpm test`
Expected: PASS across all six packages.

Run: `rtk proxy pnpm build`
Expected: PASS — types emit cleanly.

- [ ] **Step 4: Lint and commit**

```bash
pnpm exec biome check --write ./packages
git add packages/test/src/daemon.ts packages/test/test/
git commit -m "fix(test): adapt daemon waits to the async status union"
```

---

### Task 12: Document the breaking changes

**Files:**
- Create: `packages/process/README.md`

**Interfaces:**
- Consumes: everything.
- Produces: the migration record. There is no `.changeset/` in this repo — changesets arrive with `docs/agents/plans/next/2026-07-06-publishing-readiness.md` — so the README carries the record until then.

- [ ] **Step 1: Write the README**

Create `packages/process/README.md` covering: what the package does, a short example each for `runDaemon`, `ensureDaemon`, and `stopDaemon`, and a **Breaking changes in 0.2.0** section reproducing this table:

| Before | After |
|---|---|
| `getDaemonStatus(): DaemonStatus`, sync, reaps the stale pidfile | `getDaemonStatus(): Promise<DaemonStatus>`, pure, never reaps |
| `DaemonStatus = { running; pid?; stale }` | discriminated union on `state` |
| `stopDaemon(): Promise<void>`, fire-and-forget `SIGTERM` | `Promise<StopResult>`, waits and escalates by default |
| `runDaemon(): Promise<void>` | `Promise<DaemonHandle>` (source-compatible) |
| `ensureDaemon({ timeoutMs })` bounds the connect only | bounds the whole call; default 5000 → 10_000 |
| `@tejika/env` `getPidPath` | `getPIDPath` — hard rename, no alias |

Also document the **pidfile format change**, which is the one that bites at upgrade time. A bare integer becomes a JSON `LockRecord`. An old daemon's pidfile reads as corrupt (`null`) to the new `getDaemonStatus`, which classifies it `not-running` — so a running old-format daemon is reported absent, and a new one will try to boot beside it. It then hits the live-socket check and refuses with `DaemonAlreadyRunningError`. No split-brain results, but the error is confusing. State plainly: **stop any running daemon before upgrading.**

- [ ] **Step 2: Verify the claims in the README**

Every code example must run. Extract each into a scratch file and execute it, or assert the same behaviour already exists in a test. Do not ship an example you have not run.

- [ ] **Step 3: Commit**

```bash
pnpm exec biome check --write ./packages
git add packages/process/README.md
git commit -m "docs(process): document the 0.2.0 breaking changes"
```

---

### Task 13: File the upstream Enkaku issues and the Sakui migration item

**Files:**
- Create: `docs/agents/plans/backlog/2026-07-09-sakui-tejika-api-migration.md`
- Modify: `docs/superpowers/plans/2026-07-09-process-daemon-robustness.md` (this file — record the issue links)
- Modify: `docs/agents/plans/backlog/2026-07-05-extend-process-daemon-serving-and-client.md` (mark P1 and P2 done)

**Interfaces:**
- Consumes: nothing.
- Produces: the upstream and downstream paper trail the spec's acceptance criteria require.

- [ ] **Step 1: File the two Enkaku issues**

Both are upstream bugs, and the AGENTS.md guardrail forbids working around them here.

1. `@enkaku/socket` `connectSocket` leaves both the `connect` and `error` listeners attached, and offers no connect timeout. (Mitigated locally in `client.ts`'s `connectWithTimeout`, which destroys the late socket — but the listener leak remains upstream.)
2. `SocketTransport.dispose` only unrefs its socket rather than destroying it.

`docs/agents/enkaku.md` does **not** record where the Enkaku repo lives on disk, and there is no `../enkaku` sibling. **Ask the user for the repo location or slug before filing** — do not guess it, and do not run `gh issue create` against a guessed repository. Record both issue URLs under this plan's `## Upstream issues` heading.

- [ ] **Step 2: File the Sakui migration backlog item**

Create `docs/agents/plans/backlog/2026-07-09-sakui-tejika-api-migration.md` recording the exact call sites that break, verified against the repo at `/Users/paul/dev/yulsi/sakui`:

- `apps/cli/src/paths.ts:3` — `getPidPath` → `getPIDPath`
- `apps/cli/src/daemon/controller.ts:9` — `spawnDaemon`; may now pass `pidPath`/`logPath`/`env` directly
- `apps/cli/src/daemon/lifecycle.ts:2` — `getDaemonStatus` is now async, returns a `state` union
- `apps/cli/src/commands/status.ts:1` — same
- `apps/cli/src/commands/stop.ts:1` — `getDaemonStatus` and `stopDaemon`; the latter now resolves a `StopResult` and waits by default
- `apps/cli/test/controller.test.ts:6` — `getDaemonStatus`

Note also that Sakui can now delete its bespoke serving loop (`apps/cli/src/daemon/host.ts`) in favour of `runDaemon` + `createTransport`, and its duplicated reconnect body in favour of `createDaemonTransport` — that was the motivation for folding P1 and P2 into this pass.

- [ ] **Step 3: Close out the P1/P2 backlog item**

In `docs/agents/plans/backlog/2026-07-05-extend-process-daemon-serving-and-client.md`, mark P1 and P2 as delivered by this plan, with a pointer to the spec. Do not delete the file — its Sakui adoption notes are still live and are referenced by the new migration item.

- [ ] **Step 4: Full verification**

Run each and read the output before claiming success:

```bash
rtk proxy pnpm test
rtk proxy pnpm build
pnpm exec biome check ./packages
```

Then confirm the spec's acceptance criteria by test name:

| Criterion | Test |
|---|---|
| Two concurrent boots: one wins, no live socket unlinked | `daemon.test.ts` → "two concurrent boots: exactly one wins, no live socket is unlinked" |
| `EPERM` reports running-not-owned, never reaps | `status.test.ts` → "EPERM means running-not-owned, never stale" |
| A recycled PID does not wedge `runDaemon` | `status.test.ts` → "a live process whose socket is dead is a recycled pid: stale" |
| Boot crash surfaces the child's error + `logPath` fast | `spawn.test.ts` → "surfaces a boot crash before the socket-wait timeout" |
| `ensureDaemon({ timeoutMs })` bounds the whole call | `controller.test.ts` → "timeoutMs bounds the whole call, not just the connect retries" |
| `runDaemon` without `createTransport` is unchanged | `daemon.test.ts` → every test that omits it |
| `createDaemonClient` keeps its signature | `controller.test.ts` → "spawns a daemon and returns a working client" |

- [ ] **Step 5: Commit**

```bash
git add docs/agents/plans/backlog/ docs/superpowers/plans/2026-07-09-process-daemon-robustness.md
git commit -m "docs: record the Sakui migration and upstream Enkaku issues"
```

---

## Upstream issues

Filled in during Task 13, Step 1. Ask the user for the Enkaku repo location first.

- [ ] `@enkaku/socket` `connectSocket` listener leak + no connect timeout — <link>
- [ ] `SocketTransport.dispose` unrefs instead of destroying — <link>
