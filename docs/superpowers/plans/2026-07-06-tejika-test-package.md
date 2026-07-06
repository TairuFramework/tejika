# `@tejika/test` Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New `@tejika/test` package: generic integration-test primitives (node-pty driver, CLI runner, disposable env-override profiles, daemon waits, poll, globalSetup helpers) extracted from Mokei's and Sakui's hand-rolled harnesses, dogfooded by tejika's own tests.

**Architecture:** Class core + free functions (spec approach A). `PTYDriver` is a subclass-or-wrap class over node-pty; `runCLI`, `createTestProfile`, `poll`, daemon waits, and setup helpers are functions. `poll` is the shared wait primitive. Daemon waits build on `@tejika/process` `getDaemonStatus` with explicit `pidPath`. Spec: `docs/superpowers/specs/2026-07-06-tejika-test-package-design.md`.

**Tech Stack:** TypeScript (strict, ES2025, NodeNext), swc build, vitest, node-pty, strip-ansi, `@tejika/env`, `@tejika/process`.

## Global Constraints

- Guardrails (AGENTS.md): `type` not `interface`; `Array<T>` not `T[]`; no `any` (use `unknown`); ES private fields (`#field`) not TS `private`/`readonly`; uppercase abbreviations in names (`PTY`, `CLI`, `PID`); `pnpm` only, never `npm`/`npx`; never edit `lib/`.
- Tests: vitest, `test` not `it`, `import { describe, expect, test } from 'vitest'`, files in `test/*.test.ts`.
- All commands run from repo root `/Users/paul/dev/yulsi/tejika` unless a `cwd` is given.
- Internal deps use `workspace:^`; third-party versions go through the pnpm catalog (`pnpm-workspace.yaml`).
- Every task ends green: the named test command passes before its commit.
- Plan deviations from spec (both deliberate, decided during planning):
  1. `createTestProfile` is **sync** (returns `TestProfile`, not `Promise`) — nothing inside is async; `await using` still works via `AsyncDisposable`.
  2. The `@tejika/process` dogfood test lives in `packages/test` (not `packages/process`) — a `process` devDependency on `@tejika/test` would create a workspace dependency cycle (`test` already has a regular dep on `process`). Same coverage, no cycle.

---

### Task 1: Package scaffold + `poll`

**Files:**
- Create: `packages/test/package.json`
- Create: `packages/test/tsconfig.json`
- Create: `packages/test/src/index.ts`
- Create: `packages/test/src/poll.ts`
- Create: `packages/test/test/poll.test.ts`
- Modify: `pnpm-workspace.yaml` (catalog entry for `node-pty`)

**Interfaces:**
- Produces: `poll<T>(fn: () => T | Promise<T>, options?: PollOptions): Promise<T | undefined>` with `PollOptions = { timeoutMs?: number; intervalMs?: number }` (defaults 15_000 / 100). Resolves the first truthy result of `fn`, `undefined` on timeout; always calls `fn` at least once. Tasks 3 and 6 import it from `./poll.js`.

- [ ] **Step 1: Scaffold the package**

`packages/test/package.json` (scaffold mirrors `packages/env/package.json`; node-pty and strip-ansi are needed by Task 3 but declared now so install runs once):

```json
{
  "name": "@tejika/test",
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": "./lib/index.js"
  },
  "files": [
    "lib/*"
  ],
  "sideEffects": false,
  "scripts": {
    "build:clean": "del lib",
    "build:js": "swc src -d ./lib --config-file ../../node_modules/@kigu/dev/swc.json --strip-leading-paths",
    "build:types": "tsc --emitDeclarationOnly --skipLibCheck",
    "build:types:ci": "tsc --emitDeclarationOnly --skipLibCheck --declarationMap false",
    "build": "pnpm run build:clean && pnpm run build:js && pnpm run build:types",
    "test:types": "tsc --noEmit --skipLibCheck",
    "test:unit": "vitest run",
    "test": "pnpm run test:types && pnpm run test:unit"
  },
  "dependencies": {
    "@tejika/env": "workspace:^",
    "@tejika/process": "workspace:^",
    "node-pty": "catalog:",
    "strip-ansi": "catalog:"
  },
  "devDependencies": {
    "@enkaku/server": "catalog:",
    "@types/node": "catalog:"
  }
}
```

`packages/test/tsconfig.json` (identical shape to `packages/env/tsconfig.json`):

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

`packages/test/src/index.ts` (placeholder, filled in Task 7):

```ts
export { poll, type PollOptions } from './poll.js'
```

In `pnpm-workspace.yaml`, add to the `catalog:` map (alphabetical, after `nano-spawn`):

```yaml
  node-pty: ^1.1.0
```

(`strip-ansi` is already in the catalog; `node-pty` is already in `allowBuilds`.)

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: succeeds; `node-pty` native build allowed via existing `allowBuilds` entry.

- [ ] **Step 3: Write failing tests for `poll`**

`packages/test/test/poll.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { poll } from '../src/poll.js'

describe('poll', () => {
  test('resolves the first truthy result', async () => {
    let calls = 0
    const result = await poll(() => {
      calls++
      return calls >= 3 ? 'done' : undefined
    }, { intervalMs: 10 })
    expect(result).toBe('done')
    expect(calls).toBe(3)
  })

  test('supports async functions', async () => {
    const result = await poll(async () => 42)
    expect(result).toBe(42)
  })

  test('returns undefined on timeout', async () => {
    const start = Date.now()
    const result = await poll(() => false, { timeoutMs: 100, intervalMs: 10 })
    expect(result).toBeUndefined()
    expect(Date.now() - start).toBeGreaterThanOrEqual(100)
  })

  test('calls fn at least once even with a zero timeout', async () => {
    let calls = 0
    const result = await poll(() => {
      calls++
      return 'immediate'
    }, { timeoutMs: 0 })
    expect(result).toBe('immediate')
    expect(calls).toBe(1)
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @tejika/test exec vitest run test/poll.test.ts`
Expected: FAIL — cannot resolve `../src/poll.js`.

- [ ] **Step 5: Implement `poll`**

`packages/test/src/poll.ts`:

```ts
import { setTimeout as delay } from 'node:timers/promises'

export type PollOptions = {
  timeoutMs?: number
  intervalMs?: number
}

/**
 * Poll `fn` until it returns a truthy value; resolve `undefined` on timeout.
 * Always calls `fn` at least once. The wait primitive under `PTYDriver.waitFor*`
 * and the daemon wait helpers, exported for consumers' own conditions.
 */
export async function poll<T>(
  fn: () => T | Promise<T>,
  options: PollOptions = {},
): Promise<T | undefined> {
  const { timeoutMs = 15_000, intervalMs = 100 } = options
  const end = Date.now() + timeoutMs
  while (true) {
    const result = await fn()
    if (result) return result
    if (Date.now() >= end) return undefined
    await delay(intervalMs)
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @tejika/test exec vitest run test/poll.test.ts`
Expected: 4 passed.

- [ ] **Step 7: Type-check and lint**

Run: `pnpm --filter @tejika/test run test:types && rtk proxy pnpm run lint`
Expected: clean (lint may rewrite formatting — restage if so).

- [ ] **Step 8: Commit**

```bash
git add packages/test pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(test): scaffold @tejika/test with poll primitive"
```

---

### Task 2: `runCLI`

**Files:**
- Create: `packages/test/src/run.ts`
- Create: `packages/test/test/run.test.ts`

**Interfaces:**
- Produces: `runCLI(args: Array<string>, options?: RunCLIOptions): Promise<CLIResult>` with `RunCLIOptions = { command?: string; env?: Record<string, string | undefined>; cwd?: string; input?: string; signal?: AbortSignal }` (command default `'node'`) and `CLIResult = { stdout: string; stderr: string; code: number | null }`. Never rejects; spawn errors surface as `code: null` + message appended to `stderr`.

- [ ] **Step 1: Write failing tests**

`packages/test/test/run.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { runCLI } from '../src/run.js'

describe('runCLI', () => {
  test('collects stdout, stderr, and the exit code', async () => {
    const result = await runCLI([
      '-e',
      'console.log("out"); console.error("err"); process.exit(2)',
    ])
    expect(result.stdout).toBe('out\n')
    expect(result.stderr).toBe('err\n')
    expect(result.code).toBe(2)
  })

  test('resolves instead of rejecting when the command cannot spawn', async () => {
    const result = await runCLI(['--version'], { command: 'definitely-not-a-command-xyz' })
    expect(result.code).toBeNull()
    expect(result.stderr).toContain('ENOENT')
  })

  test('passes env to the child', async () => {
    const result = await runCLI(['-e', 'console.log(process.env.TEJIKA_TEST_MARKER)'], {
      env: { ...process.env, TEJIKA_TEST_MARKER: 'marked' },
    })
    expect(result.stdout).toBe('marked\n')
  })

  test('pipes input to stdin and closes it', async () => {
    const result = await runCLI(['-e', 'process.stdin.pipe(process.stdout)'], {
      input: 'echoed',
    })
    expect(result.stdout).toBe('echoed')
    expect(result.code).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @tejika/test exec vitest run test/run.test.ts`
Expected: FAIL — cannot resolve `../src/run.js`.

- [ ] **Step 3: Implement `runCLI`**

`packages/test/src/run.ts`:

```ts
import { spawn } from 'node:child_process'

export type RunCLIOptions = {
  command?: string
  env?: Record<string, string | undefined>
  cwd?: string
  input?: string
  signal?: AbortSignal
}

export type CLIResult = { stdout: string; stderr: string; code: number | null }

/**
 * Run a non-interactive CLI command to completion and collect its output.
 * Never rejects: a spawn failure (e.g. ENOENT) resolves immediately with the
 * error message appended to `stderr` and `code: null`, instead of hanging
 * until the test timeout.
 */
export function runCLI(args: Array<string>, options: RunCLIOptions = {}): Promise<CLIResult> {
  return new Promise((resolve) => {
    const child = spawn(options.command ?? 'node', args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    child.on('error', (err) => resolve({ stdout, stderr: stderr + err.message, code: null }))
    child.on('close', (code) => resolve({ stdout, stderr, code }))
    if (options.input != null) {
      child.stdin?.end(options.input)
    }
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tejika/test exec vitest run test/run.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/test/src/run.ts packages/test/test/run.test.ts
git commit -m "feat(test): add runCLI non-interactive runner"
```

---

### Task 3: `PTYDriver`

**Files:**
- Create: `packages/test/src/pty.ts`
- Create: `packages/test/test/fixtures/pty-app.js`
- Create: `packages/test/test/pty.test.ts`

**Interfaces:**
- Consumes: `poll` from `./poll.js` (Task 1).
- Produces: `class PTYDriver implements Disposable` with `PTYDriverOptions = { command?: string; args: Array<string>; cwd?: string; env?: Record<string, string>; cols?: number; rows?: number; name?: string }` (defaults: `'node'`, 100×30, `'xterm-color'`) and `PTYExit = { exitCode: number; signal?: number }`. Methods: `screen()`, `mark()`, `screenSince(since)`, `screenAfterLast(marker)`, `waitFor(text, timeoutMs?)`, `waitForSince(text, since, timeoutMs?)`, `waitForAfterLast(marker, text, timeoutMs?)` (all default 15_000, return `Promise<boolean>`), `waitForExit(timeoutMs?)` (default 8_000, `Promise<PTYExit | null>`), `write(data)`, `type(text, cps?)` (default 50), `enter()`, `esc()`, `tab()`, `up()`, `down()`, `left()`, `right()`, `ctrlC()`, `kill()`, `[Symbol.dispose]()`. Task 9 imports it from `@tejika/test`.

- [ ] **Step 1: Create the PTY fixture**

`packages/test/test/fixtures/pty-app.js` (plain JS so the spawned node needs no loader; raw stdin requires the PTY the driver provides):

```js
// Raw-stdin fixture for PTYDriver tests. Prints markers the tests wait on.
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.setEncoding('utf8')
let typed = ''
console.log('\u001b[32mready\u001b[0m')
process.stdin.on('data', (key) => {
  switch (key) {
    case '\u0003': // ^C — interrupt marker, stays alive (tests single-^C behavior)
      console.log('interrupted')
      break
    case 'q':
      process.exit(0)
      break
    case '\u001b[B': // down arrow
      console.log('down-arrow')
      break
    case '\r':
      console.log(`submitted:${typed}`)
      typed = ''
      break
    default:
      typed += key
  }
})
```

- [ ] **Step 2: Write failing tests**

`packages/test/test/pty.test.ts`:

```ts
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { PTYDriver } from '../src/pty.js'

const fixture = fileURLToPath(new URL('./fixtures/pty-app.js', import.meta.url))

const createDriver = () => new PTYDriver({ args: [fixture] })

describe('PTYDriver', () => {
  test('waitFor sees output with ANSI stripped', async () => {
    using driver = createDriver()
    expect(await driver.waitFor('ready')).toBe(true)
    expect(driver.screen()).toContain('ready')
    expect(driver.screen()).not.toContain('\u001b')
  })

  test('type + enter round-trips through the fixture', async () => {
    using driver = createDriver()
    expect(await driver.waitFor('ready')).toBe(true)
    await driver.type('abc')
    driver.enter()
    expect(await driver.waitFor('submitted:abc')).toBe(true)
  })

  test('windowed reads only match output after the mark', async () => {
    using driver = createDriver()
    expect(await driver.waitFor('ready')).toBe(true)
    const since = driver.mark()
    expect(driver.screenSince(since)).not.toContain('ready')
    driver.down()
    expect(await driver.waitForSince('down-arrow', since)).toBe(true)
  })

  test('screenAfterLast isolates the window from the last marker', async () => {
    using driver = createDriver()
    expect(await driver.waitFor('ready')).toBe(true)
    await driver.type('one')
    driver.enter()
    expect(await driver.waitFor('submitted:one')).toBe(true)
    await driver.type('two')
    driver.enter()
    expect(await driver.waitForAfterLast('submitted:', 'two')).toBe(true)
    expect(driver.screenAfterLast('submitted:')).not.toContain('one')
  })

  test('ctrlC interrupts without killing; q exits cleanly', async () => {
    using driver = createDriver()
    expect(await driver.waitFor('ready')).toBe(true)
    driver.ctrlC()
    expect(await driver.waitFor('interrupted')).toBe(true)
    expect(await driver.waitForExit(300)).toBeNull()
    driver.write('q')
    const exit = await driver.waitForExit(8_000)
    expect(exit?.exitCode).toBe(0)
  })

  test('kill after exit is tolerated', async () => {
    const driver = createDriver()
    expect(await driver.waitFor('ready')).toBe(true)
    driver.write('q')
    expect(await driver.waitForExit(8_000)).not.toBeNull()
    expect(() => driver.kill()).not.toThrow()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @tejika/test exec vitest run test/pty.test.ts`
Expected: FAIL — cannot resolve `../src/pty.js`.

- [ ] **Step 4: Implement `PTYDriver`**

`packages/test/src/pty.ts`:

```ts
import { setTimeout as delay } from 'node:timers/promises'
import { type IPty, spawn } from 'node-pty'
import stripAnsi from 'strip-ansi'
import { poll } from './poll.js'

export type PTYDriverOptions = {
  command?: string
  args: Array<string>
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  name?: string
}

export type PTYExit = { exitCode: number; signal?: number }

const ESC = '\u001b'
const ETX = '\u0003'

/**
 * Drives a real terminal app over a PTY (node-pty). Ink and other TUI
 * frameworks need a TTY on stdin (setRawMode), which a plain child_process
 * pipe cannot provide. Output accumulates in a buffer: `screen()` is the
 * ANSI-stripped whole, `mark()`/`screenSince()`/`screenAfterLast()` give
 * windowed views, `waitFor*` poll until text appears. Subclass or wrap it to
 * add app-specific flows. `using driver = new PTYDriver(...)` kills the PTY
 * at scope exit.
 */
export class PTYDriver implements Disposable {
  #pty: IPty
  #buf = ''
  #exit: PTYExit | null = null

  constructor(options: PTYDriverOptions) {
    this.#pty = spawn(options.command ?? 'node', options.args, {
      name: options.name ?? 'xterm-color',
      cols: options.cols ?? 100,
      rows: options.rows ?? 30,
      cwd: options.cwd,
      env: options.env ?? (process.env as Record<string, string>),
    })
    this.#pty.onData((data) => {
      this.#buf += data
    })
    this.#pty.onExit((exit) => {
      this.#exit = exit
    })
  }

  /** ANSI-stripped view of everything rendered so far. */
  screen(): string {
    return stripAnsi(this.#buf).replace(/\r/g, '')
  }

  /** Current raw buffer length — a marker for "output produced after this point". */
  mark(): number {
    return this.#buf.length
  }

  /** ANSI-stripped view of only the output appended after `since` (see mark()). */
  screenSince(since: number): string {
    return stripAnsi(this.#buf.slice(since)).replace(/\r/g, '')
  }

  /**
   * ANSI-stripped view from the LAST occurrence of `marker` onward. Use to
   * isolate the most recent render window after an event that emits a known
   * boundary string, even when the app batches the boundary and the following
   * frame into one data chunk.
   */
  screenAfterLast(marker: string): string {
    const full = this.screen()
    const at = full.lastIndexOf(marker)
    return at === -1 ? '' : full.slice(at)
  }

  /** Resolve true once `text` appears on screen, false on timeout. */
  async waitFor(text: string, timeoutMs = 15_000): Promise<boolean> {
    return (await poll(() => this.screen().includes(text), { timeoutMs })) ?? false
  }

  /** Like waitFor, but only matches output appended after `since` (see mark()). */
  async waitForSince(text: string, since: number, timeoutMs = 15_000): Promise<boolean> {
    return (await poll(() => this.screenSince(since).includes(text), { timeoutMs })) ?? false
  }

  /** Like waitFor, but only matches in the window from the last `marker`. */
  async waitForAfterLast(marker: string, text: string, timeoutMs = 15_000): Promise<boolean> {
    return (await poll(() => this.screenAfterLast(marker).includes(text), { timeoutMs })) ?? false
  }

  /** Resolve with the process exit info once it exits, or null on timeout. */
  async waitForExit(timeoutMs = 8_000): Promise<PTYExit | null> {
    return (await poll(() => this.#exit, { timeoutMs })) ?? null
  }

  write(data: string): void {
    this.#pty.write(data)
  }

  /** Type at human speed; instant writes race TUI renders and autocompletes. */
  async type(text: string, cps = 50): Promise<void> {
    for (const char of text) {
      this.#pty.write(char)
      await delay(1000 / cps)
    }
  }

  enter(): void {
    this.#pty.write('\r')
  }

  esc(): void {
    this.#pty.write(ESC)
  }

  tab(): void {
    this.#pty.write('\t')
  }

  up(): void {
    this.#pty.write(`${ESC}[A`)
  }

  down(): void {
    this.#pty.write(`${ESC}[B`)
  }

  right(): void {
    this.#pty.write(`${ESC}[C`)
  }

  left(): void {
    this.#pty.write(`${ESC}[D`)
  }

  /** Send a single Ctrl+C (^C) without killing the PTY, to drive quit flows. */
  ctrlC(): void {
    this.#pty.write(ETX)
  }

  kill(): void {
    try {
      this.#pty.write(ETX)
      this.#pty.kill()
    } catch {
      // Already exited.
    }
  }

  [Symbol.dispose](): void {
    this.kill()
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @tejika/test exec vitest run test/pty.test.ts`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add packages/test/src/pty.ts packages/test/test/pty.test.ts packages/test/test/fixtures/pty-app.js
git commit -m "feat(test): add PTYDriver for real-TTY integration tests"
```

---

### Task 4: `createTestProfile`

**Files:**
- Create: `packages/test/src/profile.ts`
- Create: `packages/test/test/profile.test.ts`

**Interfaces:**
- Consumes: `appEnvVar(app: string, key: string): string` from `@tejika/env`.
- Produces: `createTestProfile(app: string, options?: TestProfileOptions): TestProfile` (sync — plan deviation 1) with `TestProfileEnv = { dir: string; env: Record<string, string> }`, `TestProfile = TestProfileEnv & AsyncDisposable`, `TestProfileOptions = { keys?: Array<string>; extraEnv?: Record<string, string>; onDispose?: (profile: TestProfileEnv) => Promise<void> | void }`. Default keys `['DATA_DIR', 'STATE_DIR']`. Task 8 imports it from `../src/profile.js`.

- [ ] **Step 1: Write failing tests**

`packages/test/test/profile.test.ts`:

```ts
import { existsSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { createTestProfile } from '../src/profile.js'

describe('createTestProfile', () => {
  test('creates a temp dir and points the default env keys at it', async () => {
    await using profile = createTestProfile('my-app')
    expect(existsSync(profile.dir)).toBe(true)
    expect(profile.env.MY_APP_DATA_DIR).toBe(profile.dir)
    expect(profile.env.MY_APP_STATE_DIR).toBe(profile.dir)
  })

  test('supports custom keys and extraEnv, with extraEnv winning', async () => {
    await using profile = createTestProfile('my-app', {
      keys: ['DATA_DIR', 'SOCKET_PATH'],
      extraEnv: { MY_APP_SOCKET_PATH: '/custom/path.sock', OTHER: 'value' },
    })
    expect(profile.env.MY_APP_DATA_DIR).toBe(profile.dir)
    expect(profile.env.MY_APP_STATE_DIR).toBeUndefined()
    expect(profile.env.MY_APP_SOCKET_PATH).toBe('/custom/path.sock')
    expect(profile.env.OTHER).toBe('value')
  })

  test('two profiles in one worker get distinct dirs', async () => {
    await using first = createTestProfile('my-app')
    await using second = createTestProfile('my-app')
    expect(first.dir).not.toBe(second.dir)
  })

  test('dispose runs onDispose before removing the dir', async () => {
    let dirExistedInHook = false
    let hookDir = ''
    const profile = createTestProfile('my-app', {
      onDispose: ({ dir }) => {
        hookDir = dir
        dirExistedInHook = existsSync(dir)
      },
    })
    await profile[Symbol.asyncDispose]()
    expect(hookDir).toBe(profile.dir)
    expect(dirExistedInHook).toBe(true)
    expect(existsSync(profile.dir)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @tejika/test exec vitest run test/profile.test.ts`
Expected: FAIL — cannot resolve `../src/profile.js`.

- [ ] **Step 3: Implement `createTestProfile`**

`packages/test/src/profile.ts`:

```ts
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appEnvVar } from '@tejika/env'

export type TestProfileEnv = { dir: string; env: Record<string, string> }
export type TestProfile = TestProfileEnv & AsyncDisposable

export type TestProfileOptions = {
  /** Env keys pointed at the profile dir (via `appEnvVar`). Default `['DATA_DIR', 'STATE_DIR']`. */
  keys?: Array<string>
  /** Extra env entries; win over the key-derived ones. */
  extraEnv?: Record<string, string>
  /** Runs at dispose before the dir is removed — stop any daemon here. */
  onDispose?: (profile: TestProfileEnv) => Promise<void> | void
}

let counter = 0

/**
 * Allocate a throwaway app profile: a temp dir with `<APP>_<KEY>` env
 * overrides pointing at it, so everything a spawned CLI resolves through
 * `@tejika/env` lands in the dir. Use with `await using`, so at scope exit
 * `onDispose` runs (stop the daemon the profile spawned) and the dir is
 * removed. The pid + monotonic counter keep concurrent workers and repeated
 * profiles in one worker from colliding.
 */
export function createTestProfile(app: string, options: TestProfileOptions = {}): TestProfile {
  const { keys = ['DATA_DIR', 'STATE_DIR'], extraEnv, onDispose } = options
  const dir = join(tmpdir(), `${app}-it-${process.pid}-${counter++}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const env = { ...process.env } as Record<string, string>
  for (const key of keys) {
    env[appEnvVar(app, key)] = dir
  }
  Object.assign(env, extraEnv)
  return {
    dir,
    env,
    async [Symbol.asyncDispose]() {
      await onDispose?.({ dir, env })
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tejika/test exec vitest run test/profile.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/test/src/profile.ts packages/test/test/profile.test.ts
git commit -m "feat(test): add disposable env-override test profiles"
```

---

### Task 5: Setup helpers (`assertBuilt` / `rebuild`)

**Files:**
- Create: `packages/test/src/setup.ts`
- Create: `packages/test/test/setup.test.ts`

**Interfaces:**
- Produces: `assertBuilt(packages: Array<string>, from?: string): void` (throws one error listing every unresolvable package; `from` is a file path or `import.meta.url` for `createRequire` resolution base, default cwd) and `rebuild(dir: string, script?: string): void` (runs `pnpm run <script>`, default `build:js`, in `dir` with inherited stdio). Task 6's globalSetup and Task 9's cli setup consume these.

- [ ] **Step 1: Write failing tests**

`packages/test/test/setup.test.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { assertBuilt, rebuild } from '../src/setup.js'

describe('assertBuilt', () => {
  test('passes for resolvable packages', () => {
    expect(() => assertBuilt(['vitest'], import.meta.url)).not.toThrow()
  })

  test('throws listing every missing package', () => {
    expect(() =>
      assertBuilt(['@tejika/definitely-missing', 'also-missing-xyz'], import.meta.url),
    ).toThrow(/@tejika\/definitely-missing, also-missing-xyz.*pnpm build/s)
  })
})

describe('rebuild', () => {
  test('runs the package build script in the given dir', () => {
    const dir = join(tmpdir(), `tejika-rebuild-${process.pid}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'rebuild-fixture',
        private: true,
        scripts: { 'build:js': "node -e \"require('node:fs').writeFileSync('out.txt', 'ok')\"" },
      }),
    )
    rebuild(dir)
    expect(existsSync(join(dir, 'out.txt'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @tejika/test exec vitest run test/setup.test.ts`
Expected: FAIL — cannot resolve `../src/setup.js`.

- [ ] **Step 3: Implement the setup helpers**

`packages/test/src/setup.ts`:

```ts
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * vitest globalSetup guard: a spawned binary imports workspace deps from their
 * built `lib/` on disk — vitest's module resolution does not help a real
 * subprocess. Throws one error listing every package that does not resolve.
 * Pass `import.meta.url` as `from` to resolve from the calling file.
 */
export function assertBuilt(packages: Array<string>, from?: string): void {
  const require = createRequire(from ?? join(process.cwd(), 'noop.js'))
  const missing = packages.filter((pkg) => {
    try {
      require.resolve(pkg)
      return false
    } catch {
      return true
    }
  })
  if (missing.length > 0) {
    throw new Error(`Not built: ${missing.join(', ')} — run \`pnpm build\` first`)
  }
}

/**
 * Rebuild the package under test (fast swc `build:js` by default) so the
 * binary a test spawns is always current. For vitest globalSetup.
 */
export function rebuild(dir: string, script = 'build:js'): void {
  execSync(`pnpm run ${script}`, { cwd: dir, stdio: 'inherit' })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tejika/test exec vitest run test/setup.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/test/src/setup.ts packages/test/test/setup.test.ts
git commit -m "feat(test): add assertBuilt/rebuild globalSetup helpers"
```

---

### Task 6: Daemon waits + vitest globalSetup

**Files:**
- Create: `packages/test/src/daemon.ts`
- Create: `packages/test/test/daemon.test.ts`
- Create: `packages/test/test/setup-deps.ts`
- Create: `packages/test/vitest.config.ts`

**Interfaces:**
- Consumes: `poll` (Task 1); `assertBuilt` (Task 5); `getDaemonStatus(opts: { app: string; pidPath?: string }): DaemonStatus` from `@tejika/process` where `DaemonStatus = { running: boolean; pid?: number; stale: boolean }`.
- Produces: `waitForDaemonRunning(options: WaitForDaemonOptions): Promise<number>` (resolves pid, **throws** on timeout) and `waitForDaemonStopped(options: WaitForDaemonOptions): Promise<void>` (**returns** on timeout — teardown semantics), with `WaitForDaemonOptions = { pidPath: string; timeoutMs?: number; intervalMs?: number }` (defaults 5_000 / 100). Task 8 imports both from `../src/daemon.js`.

- [ ] **Step 1: Add the vitest config + globalSetup**

`packages/test/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/setup-deps.ts'],
  },
})
```

`packages/test/test/setup-deps.ts`:

```ts
import { assertBuilt } from '../src/setup.js'

// src/daemon.ts and the daemon integration fixture import these packages'
// built lib/ — fail fast with a clear message instead of a resolve error.
export default function setup(): void {
  assertBuilt(['@tejika/env', '@tejika/process'], import.meta.url)
}
```

- [ ] **Step 2: Write failing tests**

`packages/test/test/daemon.test.ts`:

```ts
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { waitForDaemonRunning, waitForDaemonStopped } from '../src/daemon.js'

let counter = 0
function makePidPath(): string {
  const dir = join(tmpdir(), `tejika-daemon-wait-${process.pid}-${counter++}`)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'app.pid')
}

describe('waitForDaemonRunning', () => {
  test('resolves the pid once the pidfile names a live process', async () => {
    const pidPath = makePidPath()
    writeFileSync(pidPath, String(process.pid))
    await expect(waitForDaemonRunning({ pidPath, timeoutMs: 1_000 })).resolves.toBe(process.pid)
  })

  test('throws on timeout when no pidfile appears', async () => {
    const pidPath = makePidPath()
    await expect(waitForDaemonRunning({ pidPath, timeoutMs: 200 })).rejects.toThrow(
      /did not report running within 200ms/,
    )
  })
})

describe('waitForDaemonStopped', () => {
  test('returns once the pidfile names a dead process', async () => {
    const pidPath = makePidPath()
    const child = spawn('node', ['-e', ''])
    await once(child, 'exit')
    writeFileSync(pidPath, String(child.pid))
    await expect(waitForDaemonStopped({ pidPath, timeoutMs: 1_000 })).resolves.toBeUndefined()
  })

  test('returns (not throws) on timeout while the process is still alive', async () => {
    const pidPath = makePidPath()
    writeFileSync(pidPath, String(process.pid))
    await expect(waitForDaemonStopped({ pidPath, timeoutMs: 200 })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @tejika/test exec vitest run test/daemon.test.ts`
Expected: FAIL — cannot resolve `../src/daemon.js`. (If it fails with "Not built: @tejika/env, @tejika/process" instead, run `pnpm build` first.)

- [ ] **Step 4: Implement the daemon waits**

`packages/test/src/daemon.ts`:

```ts
import { getDaemonStatus } from '@tejika/process'
import { poll } from './poll.js'

export type WaitForDaemonOptions = {
  /**
   * Explicit pidfile path: a test profile's env overrides are not visible to
   * this process's own `@tejika/env` resolvers, so derive it from the
   * profile dir (e.g. `join(profile.dir, `${app}.pid`)`).
   */
  pidPath: string
  timeoutMs?: number
  intervalMs?: number
}

/**
 * Poll until the pidfile names a live process; resolve its pid. Throws on
 * timeout: an assertion that never sees the daemon running must fail loudly.
 * (Daemons write their pidfile only after their socket accepts connections,
 * so a connected client does not guarantee the pid is on disk yet.)
 */
export async function waitForDaemonRunning(options: WaitForDaemonOptions): Promise<number> {
  const { pidPath, timeoutMs = 5_000, intervalMs = 100 } = options
  const pid = await poll(
    () => {
      // `app` is unused by getDaemonStatus when pidPath is explicit.
      const status = getDaemonStatus({ app: '', pidPath })
      return status.running ? status.pid : undefined
    },
    { timeoutMs, intervalMs },
  )
  if (pid == null) {
    throw new Error(`daemon did not report running within ${timeoutMs}ms (pidfile: ${pidPath})`)
  }
  return pid
}

/**
 * Poll until the pidfile is gone or names a dead process. Returns on timeout
 * instead of throwing: teardown tolerates a stuck daemon (it will fail its
 * next write and exit on its own), an assertion should not hard-fail cleanup.
 */
export async function waitForDaemonStopped(options: WaitForDaemonOptions): Promise<void> {
  const { pidPath, timeoutMs = 5_000, intervalMs = 100 } = options
  await poll(() => !getDaemonStatus({ app: '', pidPath }).running, { timeoutMs, intervalMs })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @tejika/test exec vitest run test/daemon.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Run the whole package suite (config change affects all files)**

Run: `pnpm --filter @tejika/test run test:unit`
Expected: all files pass (poll, run, pty, profile, setup, daemon).

- [ ] **Step 7: Commit**

```bash
git add packages/test/src/daemon.ts packages/test/test/daemon.test.ts packages/test/test/setup-deps.ts packages/test/vitest.config.ts
git commit -m "feat(test): add daemon wait helpers on getDaemonStatus"
```

---

### Task 7: Public exports, docs, full verification

**Files:**
- Modify: `packages/test/src/index.ts`
- Create: `packages/test/README.md`
- Modify: `AGENTS.md` (package overview tree)
- Modify: `docs/agents/architecture.md` (packages list + dependency graph)

**Interfaces:**
- Produces: `@tejika/test` package entry re-exporting everything below. Tasks 8–9 and external consumers import from `@tejika/test`.

- [ ] **Step 1: Fill in the index**

`packages/test/src/index.ts` (replaces the Task 1 placeholder):

```ts
export { waitForDaemonRunning, waitForDaemonStopped, type WaitForDaemonOptions } from './daemon.js'
export { poll, type PollOptions } from './poll.js'
export {
  createTestProfile,
  type TestProfile,
  type TestProfileEnv,
  type TestProfileOptions,
} from './profile.js'
export { PTYDriver, type PTYDriverOptions, type PTYExit } from './pty.js'
export { type CLIResult, runCLI, type RunCLIOptions } from './run.js'
export { assertBuilt, rebuild } from './setup.js'
```

- [ ] **Step 2: Write the README**

`packages/test/README.md`:

```markdown
# @tejika/test

Integration-test primitives for CLIs built on the `@tejika/*` stack. Install
as a devDependency.

- `PTYDriver` — drive a real terminal app over node-pty (Ink needs a TTY on
  stdin). Buffered `screen()` with ANSI stripped, `waitFor*` polling,
  windowed reads (`mark`/`screenSince`/`screenAfterLast`), key helpers,
  `type()` at human speed, `Disposable`. Subclass it for app-specific flows.
- `runCLI` — run a non-interactive command to completion; never rejects
  (spawn failures land in the result).
- `createTestProfile` — throwaway temp dir with `<APP>_<KEY>` env overrides
  (via `@tejika/env`), `AsyncDisposable` with an `onDispose` hook for daemon
  teardown.
- `waitForDaemonRunning` / `waitForDaemonStopped` — poll a pidfile via
  `@tejika/process`; running throws on timeout, stopped tolerates it.
- `poll` — the shared truthy-poll primitive.
- `assertBuilt` / `rebuild` — vitest globalSetup helpers for tests that spawn
  built binaries.
```

- [ ] **Step 3: Update AGENTS.md**

In the `## Package Overview` tree in `AGENTS.md`, add after the `ui/` line:

```
+-- test/       # Integration-test harness: PTYDriver, runCLI, test profiles, daemon waits
```

- [ ] **Step 4: Update architecture.md**

In `docs/agents/architecture.md` `## Packages` list, add after the `@tejika/ui` bullet:

```markdown
- **`@tejika/test`** — integration-test harness for tejika-built CLIs:
  node-pty `PTYDriver`, non-interactive `runCLI`, disposable env-override test
  profiles, daemon wait helpers, vitest globalSetup helpers. Consumed as a
  devDependency only.
```

In the `## Dependency graph` code block, add after the `@tejika/ui` line:

```
@tejika/test      env + process + node-pty + strip-ansi (devDependency for consumers)
```

And extend the paragraph below the graph — replace:

```markdown
`env` underpins `process` and `server`. `cli` and `ui` are independent of each
other; consuming apps compose both.
```

with:

```markdown
`env` underpins `process` and `server`. `cli` and `ui` are independent of each
other; consuming apps compose both. `test` builds on `env` + `process` and is
test-side only — consumers (including tejika's own packages) take it as a
devDependency.
```

- [ ] **Step 5: Full build, test, lint**

Run: `pnpm build && pnpm test && rtk lint biome`
Expected: all green, including the new package's `test:types` (validates the `Disposable`/`AsyncDisposable` usage compiles) and every existing package untouched.

- [ ] **Step 6: Commit**

```bash
git add packages/test/src/index.ts packages/test/README.md AGENTS.md docs/agents/architecture.md
git commit -m "feat(test): export public API and document the package"
```

---

### Task 8: Dogfood — daemon lifecycle integration test

**Files:**
- Create: `packages/test/test/fixtures/daemon-entry.js`
- Create: `packages/test/test/daemon-lifecycle.integration.test.ts`

**Interfaces:**
- Consumes: `createTestProfile` (Task 4), `waitForDaemonRunning`/`waitForDaemonStopped` (Task 6); `runDaemon`, `stopDaemon`, `getDaemonStatus` from `@tejika/process`; `serve` from `@enkaku/server` (devDependency, already in catalog).
- Produces: nothing for later tasks — proves profile + daemon waits against a real detached daemon (plan deviation 2: lives here, not in `packages/process`, to avoid a workspace dep cycle).

- [ ] **Step 1: Create the daemon fixture**

`packages/test/test/fixtures/daemon-entry.js` (plain JS importing built workspace libs — `assertBuilt` in globalSetup guards this):

```js
import { serve } from '@enkaku/server'
import { runDaemon } from '@tejika/process'

// Minimal daemon for the lifecycle integration test. All paths resolve through
// the profile's env overrides (TEJIKA_E2E_DATA_DIR / TEJIKA_E2E_STATE_DIR):
// socket at <dir>/tejika-e2e.sock, pidfile at <dir>/tejika-e2e.pid.
await runDaemon({
  app: 'tejika-e2e',
  serve: (transport) =>
    serve({
      requireAuth: false,
      handlers: { ping: () => 'pong' },
      transport,
    }),
})
```

- [ ] **Step 2: Write the integration test**

`packages/test/test/daemon-lifecycle.integration.test.ts`:

```ts
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDaemonStatus, stopDaemon } from '@tejika/process'
import { expect, test } from 'vitest'
import { waitForDaemonRunning, waitForDaemonStopped } from '../src/daemon.js'
import { createTestProfile } from '../src/profile.js'

const APP = 'tejika-e2e'
const entry = fileURLToPath(new URL('./fixtures/daemon-entry.js', import.meta.url))

test('daemon lifecycle against an isolated profile', { timeout: 30_000 }, async () => {
  await using profile = createTestProfile(APP, {
    // Safety net if an assertion fails mid-test: stop whatever daemon the
    // profile spawned before the dir is removed.
    onDispose: async ({ dir }) => {
      const pidPath = join(dir, `${APP}.pid`)
      await stopDaemon({ app: APP, pidPath }).catch(() => {})
      await waitForDaemonStopped({ pidPath, timeoutMs: 3_000 })
    },
  })
  const pidPath = join(profile.dir, `${APP}.pid`)

  // The child resolves every path through the profile env, keeping the real
  // state/data dirs untouched.
  const child = spawn('node', [entry], { env: profile.env, stdio: 'ignore' })
  try {
    const pid = await waitForDaemonRunning({ pidPath, timeoutMs: 10_000 })
    expect(pid).toBe(child.pid)
    expect(existsSync(join(profile.dir, `${APP}.sock`))).toBe(true)

    await stopDaemon({ app: APP, pidPath })
    await waitForDaemonStopped({ pidPath })
    expect(getDaemonStatus({ app: APP, pidPath }).running).toBe(false)
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL')
  }
})
```

- [ ] **Step 3: Run it**

Run: `pnpm build && pnpm --filter @tejika/test exec vitest run test/daemon-lifecycle.integration.test.ts`
Expected: 1 passed. (The build first: the fixture imports `@tejika/process` from `lib/`.)

- [ ] **Step 4: Run the whole package suite**

Run: `pnpm --filter @tejika/test run test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/test/test/fixtures/daemon-entry.js packages/test/test/daemon-lifecycle.integration.test.ts
git commit -m "test(test): dogfood profile + daemon waits in a lifecycle integration test"
```

---

### Task 9: Dogfood — `@tejika/cli` Ink-under-PTY integration test

**Files:**
- Modify: `packages/cli/package.json` (devDependency on `@tejika/test`)
- Create: `packages/cli/vitest.config.ts`
- Create: `packages/cli/test/setup-build.ts`
- Create: `packages/cli/test/fixtures/ink-app.js`
- Create: `packages/cli/test/ink.integration.test.ts`

**Interfaces:**
- Consumes: `PTYDriver` and `rebuild` from `@tejika/test` (built `lib/`); `runInk(element: ReactElement, options?: RenderOptions): Promise<void>` from `@tejika/cli`'s built `lib/index.js`.
- Produces: nothing for later tasks — first real consumer of `PTYDriver`, and the first TTY-path coverage of `runInk`.

- [ ] **Step 1: Add the devDependency**

In `packages/cli/package.json` `devDependencies`, add (alphabetical):

```json
    "@tejika/test": "workspace:^",
```

Run: `pnpm install`
Expected: succeeds; no dependency cycle (`@tejika/test` does not depend on `@tejika/cli`).

- [ ] **Step 2: Add vitest config + build setup**

`packages/cli/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/setup-build.ts'],
  },
})
```

`packages/cli/test/setup-build.ts`:

```ts
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rebuild } from '@tejika/test'

// test -> packages/cli
const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The PTY fixture imports `../../lib/index.js` — a real subprocess needs the
// built output on disk, and this keeps it current (fast swc, no tsc).
export default function setup(): void {
  rebuild(CLI_DIR)
}
```

- [ ] **Step 3: Create the Ink fixture**

`packages/cli/test/fixtures/ink-app.js` (plain JS with `createElement` — no JSX config needed for a spawned node process):

```js
import { Text, useApp, useInput } from 'ink'
import { createElement, useState } from 'react'
import { runInk } from '../../lib/index.js'

function App() {
  const { exit } = useApp()
  const [last, setLast] = useState('none')
  useInput((input, key) => {
    if (input === 'q') exit()
    else if (key.return) setLast('enter')
    else if (input !== '') setLast(input)
  })
  return createElement(Text, null, `last:${last}`)
}

await runInk(createElement(App))
```

- [ ] **Step 4: Write the integration test**

`packages/cli/test/ink.integration.test.ts`:

```ts
import { fileURLToPath } from 'node:url'
import { PTYDriver } from '@tejika/test'
import { expect, test } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/ink-app.js', import.meta.url))

// runInk needs a real TTY (Ink calls setRawMode); PTYDriver provides one.
test('runInk renders and handles input under a real PTY', { timeout: 30_000 }, async () => {
  using driver = new PTYDriver({ args: [fixture] })
  expect(await driver.waitFor('last:none')).toBe(true)
  driver.write('a')
  expect(await driver.waitFor('last:a')).toBe(true)
  driver.enter()
  expect(await driver.waitFor('last:enter')).toBe(true)
  driver.write('q')
  const exit = await driver.waitForExit()
  expect(exit?.exitCode).toBe(0)
})
```

- [ ] **Step 5: Run it**

Run: `pnpm build && pnpm --filter @tejika/cli run test`
Expected: existing cli tests + the new integration test pass. (`pnpm build` ensures `@tejika/test`'s `lib/` exists for the globalSetup import; the globalSetup then keeps cli's own `lib/` current per run.)

- [ ] **Step 6: Full repo verification**

Run: `pnpm build && pnpm test && rtk lint biome`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/package.json packages/cli/vitest.config.ts packages/cli/test/setup-build.ts packages/cli/test/fixtures/ink-app.js packages/cli/test/ink.integration.test.ts pnpm-lock.yaml
git commit -m "test(cli): cover runInk under a real PTY via @tejika/test"
```
