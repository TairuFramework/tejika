# `getLogDir` and `@tejika/log` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `getLogDir(app)` to `@tejika/env`, move `spawnDaemon`'s default `daemon.log` under it, and ship a new `@tejika/log` package that wraps `@logtape/file` into a sink factory plus a logging-config builder.

**Architecture:** `@tejika/env` gains one more path helper in the same override-then-platform-default shape as its neighbours. A new leaf package, `@tejika/log`, depends on `@tejika/env`, `@logtape/file`, `@logtape/logtape`, and `@sozai/log`; it exposes `createFileSink` (a configured rotating file sink), `createFileLogConfig` (a whole logtape `Config` built from a list of file targets), and `configureFileLogging` (that config handed to `@sozai/log`'s `setup`). `@tejika/env` gains no dependency; the logging stack stays out of `env`, `server`, and `cli`.

**Tech Stack:** TypeScript (NodeNext, `strict`), pnpm workspaces with a catalog, Turbo, SWC for JS build, `tsc` for types, Vitest, Biome. Logging is `@logtape/logtape` 2.3 via `@sozai/log`, with `@logtape/file` for the sinks.

**Spec:** `docs/superpowers/specs/2026-08-07-log-dir-and-file-sink-design.md`

## Global Constraints

- Repo conventions, from `AGENTS.md` — no `interface` (use `type`), no `T[]` (use `Array<T>`), no `any`, no lowercase abbreviations in names (`ID` not `Id`), no TS `private`/`readonly` modifiers (use `#field` + getters), `pnpm`/`pnpx` only, never edit `lib/`.
- Also read the kigu `conventions` and `development` skills before writing code.
- Never run `pnpm run <script>` on this machine: an `rtk` shim intercepts it and can invoke the wrong tool. Use the exact commands in this plan, which all go through `pnpm exec` / `pnpm --filter … exec`.
- Dependency versions, exact: `@logtape/file` `^2.3.0`, `@logtape/logtape` `^2.3.0`, `@sozai/log` `^0.3.0`. All three go in `pnpm-workspace.yaml`'s `catalog:` and are referenced as `"catalog:"` in `package.json`.
- `@tejika/log` ships at version `0.4.0`, matching the repo's lockstep versioning. Not `0.1.0`.
- The repo's TypeScript `lib` is `es2025`, which has no `Disposable` global type. Sink factories return `Sink` even though the underlying logtape object is disposable — do not write `Sink & Disposable` in a signature.
- Every commit runs a pre-commit hook that lints staged files and type-checks the whole repo. A commit step failing on types is a real failure, not a flake.
- Work happens on branch `feat/log-dir-and-file-sink`, which already exists and holds the spec commit.

---

## File Structure

**Modified:**
- `packages/env/src/paths.ts` — add `getLogDir`
- `packages/env/src/index.ts` — export it
- `packages/env/test/paths.test.ts` — cover it
- `packages/process/src/spawn.ts:3,64` — default `logPath` under the log dir
- `pnpm-workspace.yaml` — three catalog entries
- `AGENTS.md`, `docs/agents/architecture.md` — document the new package

**Created:**
- `packages/log/package.json`, `tsconfig.json`, `tsconfig.test.json` — package scaffold
- `packages/log/src/file-sink.ts` — `createFileSink`, the only file that knows `@logtape/file`
- `packages/log/src/config.ts` — `createFileLogConfig`, pure config building, no global state
- `packages/log/src/logging.ts` — `configureFileLogging`, the only file that touches logtape's global config
- `packages/log/src/index.ts` — public surface
- `packages/log/test/file-sink.test.ts`, `test/config.test.ts`, `test/logging.test.ts`
- `packages/process/test/spawn-log-path.test.ts` — default log path

Three small source files rather than one: the sink knows the filesystem, the config builder is pure and therefore trivially testable, and only `logging.ts` mutates logtape's process-global state.

---

### Task 1: `getLogDir` in `@tejika/env`

**Files:**
- Modify: `packages/env/src/paths.ts`
- Modify: `packages/env/src/index.ts:2`
- Test: `packages/env/test/paths.test.ts`

**Interfaces:**
- Consumes: `getAppEnvVar` from `./env-var.js`, `envPaths` from `env-paths` — both already imported in `paths.ts`.
- Produces: `getLogDir(app: string): string`, exported from `@tejika/env`. Tasks 2 and 3 both import it.

- [ ] **Step 1: Write the failing test**

In `packages/env/test/paths.test.ts`, add `getLogDir` to the import on line 3 (keep the list alphabetical: `getDataDir, getLockPath, getLogDir, getPIDPath, getSocketPath, getStateDir`), add the cleanup line to the existing `afterEach`, and add the new `describe` block after the `getStateDir` block:

```ts
afterEach(() => {
  delete process.env.MYAPP_DATA_DIR
  delete process.env.MYAPP_STATE_DIR
  delete process.env.MYAPP_LOG_DIR
  delete process.env.MYAPP_SOCKET_PATH
  delete process.env.MYAPP_PID_PATH
})

describe('getLogDir', () => {
  test('returns a deterministic per-app log dir', () => {
    expect(getLogDir('myapp')).toMatch(/myapp/)
  })
  test('honors the env override first', () => {
    process.env.MYAPP_LOG_DIR = '/tmp/custom-logs'
    expect(getLogDir('myapp')).toBe('/tmp/custom-logs')
  })
  // `MYAPP_LOG_DIR= node …` defines the var as '' — must fall back, not return ''.
  test('falls back when the override is empty', () => {
    process.env.MYAPP_LOG_DIR = ''
    expect(getLogDir('myapp')).toMatch(/myapp/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tejika/env exec vitest run test/paths.test.ts`
Expected: FAIL — `getLogDir is not a function`, or a TypeScript/import resolution error naming `getLogDir`.

- [ ] **Step 3: Write the implementation**

In `packages/env/src/paths.ts`, add after `getStateDir`:

```ts
/**
 * Log directory: the platform's own log location, not a subdirectory of the data dir.
 * `~/Library/Logs/<app>` on macOS, `~/.local/state/<app>/log` on Linux,
 * `AppData\Local\<app>\Log` on Windows.
 */
export function getLogDir(app: string): string {
  return getAppEnvVar(app, 'LOG_DIR') ?? envPaths(app, { suffix: '' }).log
}
```

In `packages/env/src/index.ts`, extend the `./paths.js` export:

```ts
export {
  getDataDir,
  getLockPath,
  getLogDir,
  getPIDPath,
  getSocketPath,
  getStateDir,
} from './paths.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tejika/env exec vitest run`
Expected: PASS, all files.

Run: `pnpm --filter @tejika/env exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add packages/env/src/paths.ts packages/env/src/index.ts packages/env/test/paths.test.ts
git commit -m "feat(env): add getLogDir for the platform log directory"
```

---

### Task 2: `spawnDaemon` defaults `daemon.log` under the log dir

**Files:**
- Modify: `packages/process/src/spawn.ts:3,64`
- Test: `packages/process/test/spawn-log-path.test.ts` (create)

**Interfaces:**
- Consumes: `getLogDir` from `@tejika/env` (Task 1); `spawnDaemon(opts: SpawnDaemonOptions): Promise<void>` and `stopDaemon({ app, pidPath })` already exist.
- Produces: no new API. Behaviour change only — `spawnDaemon` without `logPath` writes to `<logDir>/daemon.log` instead of `<dataDir>/daemon.log`.

- [ ] **Step 1: Write the failing test**

Create `packages/process/test/spawn-log-path.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appEnvVar } from '@tejika/env'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { spawnDaemon } from '../src/spawn.js'
import { stopDaemon } from '../src/stop.js'

const APP = 'tejika-test'
const entry = fileURLToPath(new URL('./fixtures/daemon-entry.ts', import.meta.url))
// @tejika/env's override for `getLogDir(APP)`: lets this test exercise the DEFAULT
// log path without writing to the real platform log dir.
const LOG_DIR_VAR = appEnvVar(APP, 'LOG_DIR')

let dir: string
let logDir: string
let socketPath: string
let pidPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-spawn-log-'))
  logDir = join(dir, 'logs')
  socketPath = join(dir, 'app.sock')
  pidPath = join(dir, 'app.pid')
  process.env[LOG_DIR_VAR] = logDir
})

afterEach(async () => {
  await stopDaemon({ app: APP, pidPath }).catch(() => {})
  delete process.env[LOG_DIR_VAR]
  rmSync(dir, { recursive: true, force: true })
})

// The default is the whole point: a consumer that passes no `logPath` must not get
// a log file in the data dir beside its database and socket.
test('defaults the daemon log under the log dir', { timeout: 30_000 }, async () => {
  await spawnDaemon({
    app: APP,
    entry,
    socketPath,
    pidPath,
    env: { NODE_OPTIONS: '--import tsx' },
    timeoutMs: 20_000,
  })
  expect(existsSync(join(logDir, 'daemon.log'))).toBe(true)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tejika/process exec vitest run test/spawn-log-path.test.ts`
Expected: FAIL — `expected false to be true`. The daemon boots, but its log lands in the data dir.

- [ ] **Step 3: Write the implementation**

In `packages/process/src/spawn.ts`, change the import on line 3 and the default on line 64. `getDataDir` has no other use in this package, so it leaves the import entirely:

```ts
import { getLogDir, getPIDPath, getSocketPath } from '@tejika/env'
```

```ts
  const logPath = opts.logPath ?? join(getLogDir(opts.app), 'daemon.log')
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tejika/process exec vitest run test/spawn-log-path.test.ts`
Expected: PASS.

Run: `pnpm --filter @tejika/process exec vitest run`
Expected: PASS — the existing `controller.test.ts` and `mutex.test.ts` pass `logPath` explicitly, so they are unaffected. These are daemon-spawning tests and take a while; let them finish.

- [ ] **Step 5: Commit**

```bash
git add packages/process/src/spawn.ts packages/process/test/spawn-log-path.test.ts
git commit -m "feat(process)!: default the daemon log under getLogDir

BREAKING CHANGE: spawnDaemon's default logPath moves from <dataDir>/daemon.log
to <logDir>/daemon.log. Consumers passing an explicit logPath are unaffected;
no existing file is migrated."
```

---

### Task 3: `@tejika/log` scaffold and `createFileSink`

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `packages/log/package.json`, `packages/log/tsconfig.json`, `packages/log/tsconfig.test.json`
- Create: `packages/log/src/file-sink.ts`, `packages/log/src/index.ts`
- Test: `packages/log/test/file-sink.test.ts`

**Interfaces:**
- Consumes: `getLogDir` from `@tejika/env` (Task 1); `getFileSink(path, options?)` and `getTimeRotatingFileSink(options)` from `@logtape/file`; `getJsonLinesFormatter` and the `Sink` type from `@logtape/logtape`.
- Produces, used by Task 4:
  - `type FileSinkFormat = 'text' | 'jsonLines'`
  - `type FileSinkRotation = 'daily' | 'hourly' | false`
  - `type FileSinkOptions = { app: string; name: string; dir?: string; format?: FileSinkFormat; rotate?: FileSinkRotation; retentionDays?: number; sync?: boolean }`
  - `createFileSink(options: FileSinkOptions): Sink`

- [ ] **Step 1: Create the package scaffold**

Add to the `catalog:` block in `pnpm-workspace.yaml`, keeping the block alphabetical (`@logtape/*` sort before `@sozai/lock`):

```yaml
  '@logtape/file': ^2.3.0
  '@logtape/logtape': ^2.3.0
  '@sozai/log': ^0.3.0
```

Create `packages/log/package.json`:

```json
{
  "name": "@tejika/log",
  "version": "0.4.0",
  "license": "MIT",
  "sideEffects": false,
  "type": "module",
  "exports": {
    ".": "./lib/index.js"
  },
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": [
    "lib/*"
  ],
  "scripts": {
    "build": "pnpm run build:clean && pnpm run build:js && pnpm run build:types",
    "build:clean": "del lib",
    "build:js": "swc src -d ./lib --config-file ../../node_modules/@kigu/dev/swc.json --strip-leading-paths",
    "build:types": "tsc --emitDeclarationOnly --skipLibCheck",
    "build:types:ci": "tsc --emitDeclarationOnly --skipLibCheck --declarationMap false",
    "test": "pnpm run test:types && pnpm run test:unit",
    "test:types": "tsc --noEmit --skipLibCheck -p tsconfig.test.json",
    "test:unit": "vitest run"
  },
  "dependencies": {
    "@logtape/file": "catalog:",
    "@logtape/logtape": "catalog:",
    "@sozai/log": "catalog:",
    "@tejika/env": "workspace:^"
  },
  "devDependencies": {
    "@types/node": "catalog:"
  }
}
```

Create `packages/log/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.build.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./lib",
    "rootDir": "./src",
    "types": ["node"]
  },
  "include": ["./src/**/*"]
}
```

Create `packages/log/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["./src/**/*", "./test/**/*"]
}
```

Run: `pnpm install`
Expected: the new workspace package resolves and the three catalog dependencies install.

- [ ] **Step 2: Write the failing test**

Create `packages/log/test/file-sink.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogRecord } from '@logtape/logtape'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createFileSink } from '../src/file-sink.js'

const APP = 'myapp'
let dir: string

// A minimal record, shaped like what logtape hands a sink.
function record(message: string): LogRecord {
  return {
    category: [APP, 'test'],
    level: 'info',
    message: [message],
    rawMessage: message,
    timestamp: Date.UTC(2026, 7, 7, 14, 30),
    properties: { answer: 42 },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-log-'))
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

test('creates the log directory when missing', () => {
  const target = join(dir, 'nested', 'logs')
  expect(existsSync(target)).toBe(false)
  createFileSink({ app: APP, name: 'miss', dir: target, sync: true })
  expect(existsSync(target)).toBe(true)
})

// `getTimeRotatingFileSink` takes its filename from the system clock at construction
// and at each rotation check — never from `record.timestamp`. So these two pin the
// clock instead of relying on the record's date.
test('names a daily text file after the current date', () => {
  vi.setSystemTime(new Date('2026-08-07T14:30:00Z'))
  const sink = createFileSink({ app: APP, name: 'miss', dir, sync: true })
  sink(record('hello'))
  expect(readdirSync(dir)).toEqual(['miss-2026-08-07.log'])
})

test('names an hourly file down to the hour', () => {
  vi.setSystemTime(new Date('2026-08-07T14:30:00Z'))
  const sink = createFileSink({ app: APP, name: 'miss', dir, rotate: 'hourly', sync: true })
  sink(record('hello'))
  expect(readdirSync(dir)).toEqual(['miss-2026-08-07T14.log'])
})

test('drops the date stamp when rotation is off', () => {
  const sink = createFileSink({ app: APP, name: 'miss', dir, rotate: false, sync: true })
  sink(record('hello'))
  expect(readdirSync(dir)).toEqual(['miss.log'])
})

test('writes parseable JSON lines under the jsonLines format', () => {
  const sink = createFileSink({ app: APP, name: 'miss', dir, format: 'jsonLines', sync: true })
  sink(record('first'))
  sink(record('second'))
  const lines = readFileSync(join(dir, 'miss-2026-08-07.jsonl'), 'utf8').trim().split('\n')
  expect(lines).toHaveLength(2)
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  expect(parsed[0]?.message).toBe('first')
  expect(parsed[1]?.message).toBe('second')
})

// `sync: true` sets bufferSize 0: a record written just before the process exits
// must already be on disk, with no dispose or flush in between.
test('flushes each record immediately under sync', () => {
  const sink = createFileSink({ app: APP, name: 'miss', dir, sync: true })
  sink(record('hello'))
  expect(readFileSync(join(dir, 'miss-2026-08-07.log'), 'utf8')).toContain('hello')
})

test('defaults the directory to the app log dir', () => {
  process.env.MYAPP_LOG_DIR = join(dir, 'from-env')
  try {
    createFileSink({ app: APP, name: 'miss', sync: true })
    expect(existsSync(join(dir, 'from-env'))).toBe(true)
  } finally {
    delete process.env.MYAPP_LOG_DIR
  }
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @tejika/log exec vitest run`
Expected: FAIL — cannot resolve `../src/file-sink.js`.

- [ ] **Step 4: Write the implementation**

Create `packages/log/src/file-sink.ts`:

```ts
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getFileSink, getTimeRotatingFileSink } from '@logtape/file'
import { getJsonLinesFormatter, type Sink } from '@logtape/logtape'
import { getLogDir } from '@tejika/env'

export type FileSinkFormat = 'text' | 'jsonLines'
export type FileSinkRotation = 'daily' | 'hourly' | false

export type FileSinkOptions = {
  app: string
  /** Base filename, without a date stamp or extension. */
  name: string
  /** Defaults to `getLogDir(app)`. */
  dir?: string
  /** `'text'` (default) writes `.log`, `'jsonLines'` writes `.jsonl`. */
  format?: FileSinkFormat
  /** Rotation interval, or `false` for a single file. Defaults to `'daily'`. */
  rotate?: FileSinkRotation
  /** Files older than this are pruned on rotation. Defaults to 30; ignored when `rotate` is false. */
  retentionDays?: number
  /** Flush every record as it is written, instead of buffering. Defaults to `false`. */
  sync?: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

/** `2026-08-07` daily, `2026-08-07T14` hourly — sortable, and parseable back for retention. */
function stampDate(date: Date, rotate: 'daily' | 'hourly'): string {
  const iso = date.toISOString()
  return rotate === 'daily' ? iso.slice(0, 10) : iso.slice(0, 13)
}

/**
 * A rotating log file for `app`, under `getLogDir(app)` unless told otherwise.
 *
 * The return type is `Sink` rather than logtape's `Sink & Disposable`: this repo compiles
 * against `lib: es2025`, which has no `Disposable` global. Logtape still disposes the sink
 * through the config that holds it, on `reset()` and at process exit.
 */
export function createFileSink(options: FileSinkOptions): Sink {
  const {
    app,
    name,
    dir = getLogDir(app),
    format = 'text',
    rotate = 'daily',
    retentionDays = 30,
    sync = false,
  } = options
  // Owner-only, like the socket dir beside it: local logs hold personal data.
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  const extension = format === 'jsonLines' ? 'jsonl' : 'log'
  const formatter = format === 'jsonLines' ? getJsonLinesFormatter() : undefined
  // 0 disables the sink's write buffer, so a record written just before the process
  // exits is already on disk. Left undefined, logtape applies its own default.
  const bufferSize = sync ? 0 : undefined

  if (rotate === false) {
    return getFileSink(join(dir, `${name}.${extension}`), { formatter, bufferSize })
  }

  return getTimeRotatingFileSink({
    directory: dir,
    interval: rotate,
    filename: (date) => `${name}-${stampDate(date, rotate)}.${extension}`,
    // With a custom `filename` and no `parseFilename`, logtape prunes by file mtime.
    // Parsing our own stamp back keeps retention tied to the record dates instead.
    parseFilename: (filename) => {
      const prefix = `${name}-`
      const suffix = `.${extension}`
      if (!filename.startsWith(prefix) || !filename.endsWith(suffix)) return null
      const stamp = filename.slice(prefix.length, filename.length - suffix.length)
      const date = new Date(rotate === 'daily' ? `${stamp}T00:00:00Z` : `${stamp}:00:00Z`)
      return Number.isNaN(date.getTime()) ? null : date
    },
    maxAgeMs: retentionDays * DAY_MS,
    formatter,
    bufferSize,
  })
}
```

Create `packages/log/src/index.ts`:

```ts
export {
  createFileSink,
  type FileSinkFormat,
  type FileSinkOptions,
  type FileSinkRotation,
} from './file-sink.js'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @tejika/log exec vitest run`
Expected: PASS, 7 tests.

Run: `pnpm --filter @tejika/log exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml packages/log
git commit -m "feat(log): add @tejika/log with createFileSink"
```

---

### Task 4: `createFileLogConfig`

**Files:**
- Create: `packages/log/src/config.ts`
- Modify: `packages/log/src/index.ts`
- Test: `packages/log/test/config.test.ts`

**Interfaces:**
- Consumes: `createFileSink` and `FileSinkOptions` from `./file-sink.js` (Task 3); `getConsoleSink` and the `Config` / `LogLevel` types from `@sozai/log`; the `Sink` type from `@logtape/logtape`.
- Produces, used by Task 5:
  - `type FileLogTarget = Omit<FileSinkOptions, 'app'> & { category: string | Array<string>; level?: LogLevel }`
  - `type FileLogConfigOptions = { app: string; files: Array<FileLogTarget>; console?: boolean | LogLevel }`
  - `createFileLogConfig(options: FileLogConfigOptions): Config<string, string>`

- [ ] **Step 1: Write the failing test**

Create `packages/log/test/config.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createFileLogConfig } from '../src/config.js'

const APP = 'myapp'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-log-config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('keys one sink per file target', () => {
  const config = createFileLogConfig({
    app: APP,
    files: [
      { name: 'miss', category: [APP, 'miss'], dir },
      { name: 'audit', category: [APP, 'audit'], dir },
    ],
  })
  expect(Object.keys(config.sinks).sort()).toEqual(['audit', 'miss'])
})

test('rejects two targets sharing a name', () => {
  expect(() =>
    createFileLogConfig({
      app: APP,
      files: [
        { name: 'miss', category: [APP, 'one'], dir },
        { name: 'miss', category: [APP, 'two'], dir },
      ],
    }),
  ).toThrow(/duplicate log file name: miss/i)
})

test('rejects a file target named console alongside the console sink', () => {
  expect(() =>
    createFileLogConfig({
      app: APP,
      files: [{ name: 'console', category: [APP, 'one'], dir }],
      console: true,
    }),
  ).toThrow(/reserved log file name: console/i)
})

// 'inherit' (logtape's default) UNIONS a category's sinks with its parent's, so
// without 'override' a console root entry prints every file record to stdout too.
test('overrides parent sinks on every file logger', () => {
  const config = createFileLogConfig({
    app: APP,
    files: [{ name: 'miss', category: [APP, 'miss'], dir }],
    console: true,
  })
  const fileLogger = config.loggers.find((logger) => logger.sinks?.includes('miss'))
  expect(fileLogger?.parentSinks).toBe('override')
})

test('defaults a file target to info level', () => {
  const config = createFileLogConfig({
    app: APP,
    files: [{ name: 'miss', category: [APP, 'miss'], dir }],
  })
  const fileLogger = config.loggers.find((logger) => logger.sinks?.includes('miss'))
  expect(fileLogger?.lowestLevel).toBe('info')
})

test('honors an explicit file target level', () => {
  const config = createFileLogConfig({
    app: APP,
    files: [{ name: 'miss', category: [APP, 'miss'], dir, level: 'debug' }],
  })
  const fileLogger = config.loggers.find((logger) => logger.sinks?.includes('miss'))
  expect(fileLogger?.lowestLevel).toBe('debug')
})

// File-only: logtape's own meta records must not land in the app's log files.
test('silences the meta logger when there is no console sink', () => {
  const config = createFileLogConfig({
    app: APP,
    files: [{ name: 'miss', category: [APP, 'miss'], dir }],
  })
  expect(config.sinks.console).toBeUndefined()
  const meta = config.loggers.find(
    (logger) => Array.isArray(logger.category) && logger.category[1] === 'meta',
  )
  expect(meta?.sinks).toEqual([])
  expect(config.loggers.some((logger) => logger.category.length === 0)).toBe(false)
})

// Mirrors @sozai/log's getDefaultConfig: the root entry also counts as configuring
// the meta logger, so no separate suppression entry belongs here.
test('adds a console root entry when the console is enabled', () => {
  const config = createFileLogConfig({
    app: APP,
    files: [{ name: 'miss', category: [APP, 'miss'], dir }],
    console: true,
  })
  expect(config.sinks.console).toBeDefined()
  const root = config.loggers.find((logger) => logger.category.length === 0)
  expect(root?.sinks).toEqual(['console'])
  expect(root?.lowestLevel).toBe('error')
  expect(
    config.loggers.some(
      (logger) => Array.isArray(logger.category) && logger.category[1] === 'meta',
    ),
  ).toBe(false)
})

test('honors an explicit console level', () => {
  const config = createFileLogConfig({
    app: APP,
    files: [{ name: 'miss', category: [APP, 'miss'], dir }],
    console: 'debug',
  })
  const root = config.loggers.find((logger) => logger.category.length === 0)
  expect(root?.lowestLevel).toBe('debug')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tejika/log exec vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/log/src/config.ts`:

```ts
import type { Sink } from '@logtape/logtape'
import { type Config, getConsoleSink, type LogLevel } from '@sozai/log'

import { createFileSink, type FileSinkOptions } from './file-sink.js'

export type FileLogTarget = Omit<FileSinkOptions, 'app'> & {
  category: string | Array<string>
  /** Lowest level reaching this file. Defaults to `'info'`. */
  level?: LogLevel
}

export type FileLogConfigOptions = {
  app: string
  files: Array<FileLogTarget>
  /** Also log to the console: `true` at `'error'`, or an explicit level. Defaults to `false`. */
  console?: boolean | LogLevel
}

type FileLogConfig = Config<string, string>

/**
 * Build a whole logtape `Config` from a list of log files.
 *
 * Separate from {@link configureFileLogging} because `setup()` takes ONE config and is
 * first-call-wins: two helpers cannot each contribute a sink. A host whose layout this
 * does not cover builds its own config, and this one stays testable without touching
 * logtape's process-global state.
 */
export function createFileLogConfig(options: FileLogConfigOptions): FileLogConfig {
  const withConsole = options.console != null && options.console !== false
  const sinks: Record<string, Sink> = {}
  const loggers: FileLogConfig['loggers'] = []

  for (const file of options.files) {
    if (sinks[file.name] != null) {
      throw new Error(`Duplicate log file name: ${file.name}`)
    }
    if (withConsole && file.name === 'console') {
      throw new Error('Reserved log file name: console')
    }
    sinks[file.name] = createFileSink({ ...file, app: options.app })
    loggers.push({
      category: file.category,
      lowestLevel: file.level ?? 'info',
      sinks: [file.name],
      // logtape's default, 'inherit', UNIONS these sinks with the parent's: with a console
      // root entry below, every file record would print to stdout as well.
      parentSinks: 'override',
    })
  }

  if (withConsole) {
    sinks.console = getConsoleSink()
    // Mirrors @sozai/log's getDefaultConfig. logtape counts a `category: []` entry as
    // configuring the meta logger, so its own records stay handled without a second entry.
    loggers.push({
      category: [],
      lowestLevel: options.console === true ? 'error' : (options.console as LogLevel),
      sinks: ['console'],
    })
  } else {
    // File-only: keep logtape's own meta records out of the app's log files.
    loggers.push({ category: ['logtape', 'meta'], lowestLevel: 'error', sinks: [] })
  }

  return { sinks, loggers }
}
```

Extend `packages/log/src/index.ts`:

```ts
export {
  createFileLogConfig,
  type FileLogConfigOptions,
  type FileLogTarget,
} from './config.js'
export {
  createFileSink,
  type FileSinkFormat,
  type FileSinkOptions,
  type FileSinkRotation,
} from './file-sink.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tejika/log exec vitest run`
Expected: PASS, all files.

Run: `pnpm --filter @tejika/log exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add packages/log/src/config.ts packages/log/src/index.ts packages/log/test/config.test.ts
git commit -m "feat(log): build a logtape config from file targets"
```

---

### Task 5: `configureFileLogging`

**Files:**
- Create: `packages/log/src/logging.ts`
- Modify: `packages/log/src/index.ts`
- Test: `packages/log/test/logging.test.ts`

**Interfaces:**
- Consumes: `createFileLogConfig` and `FileLogConfigOptions` from `./config.js` (Task 4); `setup`, `reset`, `getLogger` from `@sozai/log`.
- Produces:
  - `type ConfigureFileLoggingOptions = FileLogConfigOptions & { reset?: boolean }`
  - `configureFileLogging(options: ConfigureFileLoggingOptions): void`

- [ ] **Step 1: Write the failing test**

Create `packages/log/test/logging.test.ts`:

```ts
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getLogger, isSetup, reset } from '@sozai/log'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { configureFileLogging } from '../src/logging.js'

const APP = 'myapp'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-log-setup-'))
})

// logtape's configuration is process-global: leaving it set leaks into the next test.
afterEach(() => {
  reset()
  rmSync(dir, { recursive: true, force: true })
})

/** The one log file in `directory`, whatever date stamp it picked up. */
function onlyFile(directory: string): string {
  const names = readdirSync(directory).filter(
    (name) => name.endsWith('.log') || name.endsWith('.jsonl'),
  )
  expect(names).toHaveLength(1)
  return join(directory, names[0] as string)
}

test('writes a logged record to its file', () => {
  configureFileLogging({
    app: APP,
    files: [
      { name: 'miss', category: [APP, 'runtime', 'miss'], dir, format: 'jsonLines', sync: true },
    ],
  })
  expect(isSetup()).toBe(true)
  getLogger([APP, 'runtime', 'miss']).info('unmatched intent', { intent: 'play jazz' })
  const line = readFileSync(onlyFile(dir), 'utf8').trim()
  const parsed = JSON.parse(line) as Record<string, unknown>
  expect(parsed.message).toBe('unmatched intent')
  expect((parsed.properties as Record<string, unknown>).intent).toBe('play jazz')
})

// setup() returns early when logging is already configured, and swallows a `reset`
// flag set inside the config — so `reset: true` has to call reset() itself.
test('reconfigures when reset is set', () => {
  configureFileLogging({
    app: APP,
    files: [{ name: 'first', category: [APP, 'a'], dir, sync: true }],
  })
  const second = join(dir, 'second')
  configureFileLogging({
    app: APP,
    files: [{ name: 'second', category: [APP, 'a'], dir: second, sync: true }],
    reset: true,
  })
  getLogger([APP, 'a']).info('after reset')
  expect(readFileSync(onlyFile(second), 'utf8')).toContain('after reset')
})

test('leaves the existing configuration alone without reset', () => {
  configureFileLogging({
    app: APP,
    files: [{ name: 'first', category: [APP, 'a'], dir, sync: true }],
  })
  const second = join(dir, 'second')
  configureFileLogging({
    app: APP,
    files: [{ name: 'second', category: [APP, 'a'], dir: second, sync: true }],
  })
  getLogger([APP, 'a']).info('still first')
  expect(readFileSync(onlyFile(dir), 'utf8')).toContain('still first')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tejika/log exec vitest run test/logging.test.ts`
Expected: FAIL — cannot resolve `../src/logging.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/log/src/logging.ts`:

```ts
import { reset, setup } from '@sozai/log'

import { createFileLogConfig, type FileLogConfigOptions } from './config.js'

export type ConfigureFileLoggingOptions = FileLogConfigOptions & {
  /** Clear any existing configuration first. Defaults to `false`. */
  reset?: boolean
}

/**
 * Configure logging to write the given files, through `@sozai/log`.
 *
 * `reset` is handled here rather than passed through: `setup()` returns early once
 * logging is configured, so a `reset` flag inside the config never reaches
 * `configureSync` and is silently swallowed.
 */
export function configureFileLogging(options: ConfigureFileLoggingOptions): void {
  if (options.reset) reset()
  setup(createFileLogConfig(options))
}
```

Extend `packages/log/src/index.ts` with the new export, keeping the file alphabetical by module:

```ts
export {
  createFileLogConfig,
  type FileLogConfigOptions,
  type FileLogTarget,
} from './config.js'
export {
  createFileSink,
  type FileSinkFormat,
  type FileSinkOptions,
  type FileSinkRotation,
} from './file-sink.js'
export { configureFileLogging, type ConfigureFileLoggingOptions } from './logging.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tejika/log exec vitest run`
Expected: PASS, all files.

Run: `pnpm --filter @tejika/log exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add packages/log/src/logging.ts packages/log/src/index.ts packages/log/test/logging.test.ts
git commit -m "feat(log): add configureFileLogging"
```

---

### Task 6: Documentation and full verification

**Files:**
- Modify: `AGENTS.md` (package overview block)
- Modify: `docs/agents/architecture.md` (packages list and dependency graph)
- Move: `docs/agents/plans/next/2026-08-07-sakui-request-log-dir-and-file-sink.md` → `docs/agents/plans/completed/`

**Interfaces:**
- Consumes: everything from Tasks 1–5. Produces no code.

- [ ] **Step 1: Document the package in `AGENTS.md`**

In the package overview block, add the `log` line after `env` (it depends only on `env`):

```
packages/
+-- env/        # Local paths, ports, and env-var overrides (getSocketPath, getPort, ...)
+-- log/        # Local log files: rotating file sinks and logtape config (createFileSink, ...)
+-- process/    # Local daemon spawn / lifecycle / Enkaku client reconnect
```

- [ ] **Step 2: Document the package in `docs/agents/architecture.md`**

Add to the packages list, after the `@tejika/env` entry:

```markdown
- **`@tejika/log`** — local log files: `createFileSink` (a rotating `@logtape/file`
  sink under `getLogDir(app)`), `createFileLogConfig`, and `configureFileLogging`.
  The filesystem half of logging, kept out of `@sozai/log` so that package stays
  browser-safe.
```

And add to the dependency graph block:

```
@tejika/log       env + @logtape/file + @logtape/logtape + @sozai/log
```

In the paragraph under the graph, extend the first sentence so it reads: "`env` underpins `log`, `process` and `server`."

- [ ] **Step 3: Record the triage outcome and archive the request**

Append to `docs/agents/plans/next/2026-08-07-sakui-request-log-dir-and-file-sink.md`:

```markdown
## Outcome (2026-08-07)

Both asks accepted and implemented. `getLogDir(app)` landed in `@tejika/env`, defaulting
to the platform log directory (`envPaths(app).log`) rather than `<dataDir>/logs`, with a
`<APP>_LOG_DIR` override. The sink factory landed in a new `@tejika/log` package —
`createFileSink`, `createFileLogConfig`, `configureFileLogging` — keeping `@logtape/file`
out of the foundational `@tejika/env`. `spawnDaemon`'s default `daemon.log` moved under
the log dir, a breaking change for consumers that passed no `logPath`.

Sakui migrates in its own repo once these versions publish.
```

Then move it:

```bash
git mv docs/agents/plans/next/2026-08-07-sakui-request-log-dir-and-file-sink.md docs/agents/plans/completed/
```

- [ ] **Step 4: Verify the whole repo**

Run: `pnpm exec biome check --write ./packages`
Expected: no remaining diagnostics after fixes are applied. If it rewrote files, re-run the tests below.

Run: `pnpm exec turbo run build`
Expected: every package builds, `@tejika/log` included.

Run: `pnpm exec turbo run test`
Expected: PASS across all packages. The `process` and `test` package suites spawn real daemons and take minutes; let them finish.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/agents/architecture.md docs/agents/plans
git commit -m "docs: document @tejika/log and archive the Sakui request"
```

---

## Verification

After Task 6, the following must all be true:

- `pnpm exec turbo run test` passes across every package.
- `pnpm exec turbo run build` produces `packages/log/lib/index.js` and `index.d.ts`.
- `getLogDir('myapp')` honours `MYAPP_LOG_DIR` and otherwise returns the platform log dir.
- `spawnDaemon` without a `logPath` writes to `<logDir>/daemon.log`.
- `configureFileLogging({ app, files: [{ name, category, format: 'jsonLines', sync: true }] })` produces a JSONL file under the app's log dir containing every record logged to that category.
