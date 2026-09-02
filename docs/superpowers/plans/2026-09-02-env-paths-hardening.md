# Env Paths Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** executing
**Mode:** tasks

**Goal:** Harden `@tejika/env` path helpers with Windows named-pipe sockets, a POSIX socket-length guard, a predictable override/name rule, and input sanitization.

**Architecture:** All behavior changes land in `packages/env/src/paths.ts` (`getSocketPath`) and `packages/env/src/env-var.ts` (`appEnvVar`). `getSocketPath` gains a `win32` branch returning named pipes, a POSIX byte-length guard, override-as-directory-anchor derivation for named sockets, and separator rejection on `app`/`name`. `getStateDir` is unchanged. Docs land in `docs/agents/architecture.md`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, `env-paths`, Node `node:path`. Lint/format: Biome via `rtk lint biome`.

**Spec:** `docs/superpowers/specs/2026-09-01-env-paths-hardening-design.md`

## Global Constraints

- No `interface` (use `type`); no `T[]` (use `Array<T>`); no `any`.
- No lowercase abbreviations in names: `ID`, `HTTP`, `PID` — not `Id`/`Http`/`Pid`.
- No TS `private`/`readonly`; use ES `#field` + getters (N/A here — no classes).
- `pnpm`/`pnpx` only. Never edit generated `lib/`.
- Fix `@enkaku/*` bugs upstream, never work around locally (N/A here).
- Run repo scripts as `rtk proxy pnpm run <script>`; lint as `rtk lint biome` (Biome, not eslint).
- Test import specifiers end in `.js` (e.g. `../src/paths.js`).
- **Spec deviation:** the spec says "README"; `packages/env` has no README — document in `docs/agents/architecture.md` instead.

---

### Task 1: `appEnvVar` underscore-prefixes digit-leading app slugs

**Files:**
- Modify: `packages/env/src/env-var.ts`
- Test: `packages/env/test/env-var.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `appEnvVar(app, key)` — unchanged signature `(string, string) => string`; a slug whose first char is a digit gains a leading `_`.

- [ ] **Step 1: Write the failing test**

Check whether `packages/env/test/env-var.test.ts` exists. If it does, append the `describe` block below; if not, create the file with this content:

```ts
import { describe, expect, test } from 'vitest'

import { appEnvVar } from '../src/env-var.js'

describe('appEnvVar', () => {
  test('slugifies a normal app name', () => {
    expect(appEnvVar('myapp', 'DATA_DIR')).toBe('MYAPP_DATA_DIR')
  })
  test('collapses non-alphanumerics to underscores', () => {
    expect(appEnvVar('my-app.cli', 'PORT')).toBe('MY_APP_CLI_PORT')
  })
  test('prefixes an underscore when the slug starts with a digit', () => {
    // `1APP_DATA_DIR` is not a settable POSIX shell variable; `_1APP_DATA_DIR` is.
    expect(appEnvVar('1app', 'DATA_DIR')).toBe('_1APP_DATA_DIR')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm --filter @tejika/env exec vitest run test/env-var.test.ts`
Expected: FAIL on the digit-prefix case — `appEnvVar('1app','DATA_DIR')` returns `1APP_DATA_DIR`.

- [ ] **Step 3: Write minimal implementation**

In `packages/env/src/env-var.ts`, update `appEnvVar`:

```ts
export function appEnvVar(app: string, key: string): string {
  let slug = app.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  if (/^[0-9]/.test(slug)) {
    slug = `_${slug}`
  }
  return `${slug}_${key}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy pnpm --filter @tejika/env exec vitest run test/env-var.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/env/src/env-var.ts packages/env/test/env-var.test.ts
git commit -m "fix(env): underscore-prefix digit-leading app env vars"
```

---

### Task 2: `getSocketPath` rejects path separators in `app`/`name`

**Files:**
- Modify: `packages/env/src/paths.ts`
- Test: `packages/env/test/paths.test.ts`

**Interfaces:**
- Consumes: `getSocketPath(app, name?)`.
- Produces: `getSocketPath` throws `Error` when `app` or `name` contains `/`, `\`, or is exactly `..`. A module-private `assertNoSeparator(value, label)` helper.

- [ ] **Step 1: Write the failing test**

Append to `packages/env/test/paths.test.ts`:

```ts
describe('getSocketPath input sanitization', () => {
  test('rejects a slash in name', () => {
    expect(() => getSocketPath('myapp', 'a/b')).toThrow(/path separator/)
  })
  test('rejects a backslash in name', () => {
    expect(() => getSocketPath('myapp', 'a\\b')).toThrow(/path separator/)
  })
  test('rejects a ".." name', () => {
    expect(() => getSocketPath('myapp', '..')).toThrow(/path separator|\.\./)
  })
  test('rejects a slash in app', () => {
    expect(() => getSocketPath('my/app')).toThrow(/path separator/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm --filter @tejika/env exec vitest run test/paths.test.ts -t "input sanitization"`
Expected: FAIL — no throw today.

- [ ] **Step 3: Write minimal implementation**

In `packages/env/src/paths.ts`, add a module-private helper and call it at the top of `getSocketPath`:

```ts
function assertNoSeparator(value: string, label: string): void {
  if (/[/\\]/.test(value) || value === '..') {
    throw new Error(`${label} must not contain a path separator or "..": "${value}"`)
  }
}
```

At the very start of `getSocketPath`, before reading the override:

```ts
  assertNoSeparator(app, 'app')
  if (name != null) {
    assertNoSeparator(name, 'name')
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy pnpm --filter @tejika/env exec vitest run test/paths.test.ts -t "input sanitization"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/env/src/paths.ts packages/env/test/paths.test.ts
git commit -m "fix(env): reject path separators in socket app/name"
```

---

### Task 3: `getSocketPath` override anchors named sockets to `dirname(override)`

**Files:**
- Modify: `packages/env/src/paths.ts`
- Test: `packages/env/test/paths.test.ts`

**Interfaces:**
- Consumes: `getSocketPath(app, name?)`, `SOCKET_PATH` override.
- Produces: with override set and `name` given, returns `join(dirname(override), `${name}.sock`)`; with override and no name, override verbatim (unchanged).

- [ ] **Step 1: Write the failing test**

Append to `packages/env/test/paths.test.ts` (inside a new `describe`):

```ts
describe('getSocketPath override + name', () => {
  test('derives a named socket from the override directory', () => {
    process.env.MYAPP_SOCKET_PATH = '/run/app.sock'
    expect(getSocketPath('myapp', 'monitor')).toBe('/run/monitor.sock')
  })
  test('override with no name is used verbatim', () => {
    process.env.MYAPP_SOCKET_PATH = '/run/app.sock'
    expect(getSocketPath('myapp')).toBe('/run/app.sock')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm --filter @tejika/env exec vitest run test/paths.test.ts -t "override + name"`
Expected: FAIL — today the override is ignored when `name` is set, so the result is under the data dir, not `/run/monitor.sock`.

- [ ] **Step 3: Write minimal implementation**

In `packages/env/src/paths.ts`, add `dirname` to the `node:path` import:

```ts
import { dirname, join } from 'node:path'
```

Replace the body of `getSocketPath` (POSIX logic; the sanitization calls from Task 2 stay at the top):

```ts
  const override = getAppEnvVar(app, 'SOCKET_PATH')
  if (override != null) {
    return name == null ? override : join(dirname(override), `${name}.sock`)
  }
  const file = name == null ? `${app}.sock` : `${name}.sock`
  return join(getDataDir(app), file)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy pnpm --filter @tejika/env exec vitest run test/paths.test.ts`
Expected: PASS (new tests plus all existing `getSocketPath` tests).

- [ ] **Step 5: Commit**

```bash
git add packages/env/src/paths.ts packages/env/test/paths.test.ts
git commit -m "feat(env): anchor named sockets to socket-path override dir"
```

---

### Task 4: `getSocketPath` POSIX socket-length guard

**Files:**
- Modify: `packages/env/src/paths.ts`
- Test: `packages/env/test/paths.test.ts`

**Interfaces:**
- Consumes: `getSocketPath`, `appEnvVar` (import from `./env-var.js`).
- Produces: on POSIX, throws when the resolved path's byte length exceeds `104` (darwin) / `108` (other) with a message naming the byte count, platform, limit, path, and the `SOCKET_PATH` variable. Module-private `assertSocketPathLength(app, path)`.

- [ ] **Step 1: Write the failing test**

Append to `packages/env/test/paths.test.ts`. This mocks `process.platform`; add the restore to the existing `afterEach` or a local one:

```ts
describe('getSocketPath length guard', () => {
  const realPlatform = process.platform
  const setPlatform = (value: string) =>
    Object.defineProperty(process, 'platform', { value, configurable: true })
  afterEach(() => setPlatform(realPlatform))

  test('throws when the resolved path exceeds the darwin limit', () => {
    setPlatform('darwin')
    process.env.MYAPP_SOCKET_PATH = `/tmp/${'x'.repeat(110)}.sock`
    expect(() => getSocketPath('myapp')).toThrow(/exceeds darwin limit of 104/)
  })
  test('names the override variable in the hint', () => {
    setPlatform('darwin')
    process.env.MYAPP_SOCKET_PATH = `/tmp/${'x'.repeat(110)}.sock`
    expect(() => getSocketPath('myapp')).toThrow(/MYAPP_SOCKET_PATH/)
  })
  test('allows a short path on linux', () => {
    setPlatform('linux')
    process.env.MYAPP_SOCKET_PATH = '/run/app.sock'
    expect(getSocketPath('myapp')).toBe('/run/app.sock')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm --filter @tejika/env exec vitest run test/paths.test.ts -t "length guard"`
Expected: FAIL — no throw today.

- [ ] **Step 3: Write minimal implementation**

In `packages/env/src/paths.ts`, import `appEnvVar`:

```ts
import { appEnvVar, getAppEnvVar } from './env-var.js'
```

Add the guard helper:

```ts
// unix `sun_path`: 104 bytes on darwin, 108 on linux/other. An over-length bind fails
// with a cryptic error, so surface it here with the limit and a remediation hint.
function assertSocketPathLength(app: string, path: string): void {
  const limit = process.platform === 'darwin' ? 104 : 108
  const bytes = Buffer.byteLength(path)
  if (bytes > limit) {
    throw new Error(
      `socket path ${bytes} bytes exceeds ${process.platform} limit of ${limit}: ${path}. ` +
        `Set ${appEnvVar(app, 'SOCKET_PATH')} to a shorter path.`,
    )
  }
}
```

In `getSocketPath`, compute the POSIX path into a variable and guard it before returning:

```ts
  const override = getAppEnvVar(app, 'SOCKET_PATH')
  let path: string
  if (override != null) {
    path = name == null ? override : join(dirname(override), `${name}.sock`)
  } else {
    path = join(getDataDir(app), name == null ? `${app}.sock` : `${name}.sock`)
  }
  assertSocketPathLength(app, path)
  return path
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy pnpm --filter @tejika/env exec vitest run test/paths.test.ts`
Expected: PASS (all `getSocketPath` tests).

- [ ] **Step 5: Commit**

```bash
git add packages/env/src/paths.ts packages/env/test/paths.test.ts
git commit -m "feat(env): guard over-length posix socket paths"
```

---

### Task 5: `getSocketPath` Windows named pipes

**Files:**
- Modify: `packages/env/src/paths.ts`
- Test: `packages/env/test/paths.test.ts`

**Interfaces:**
- Consumes: `getSocketPath`, `process.platform`.
- Produces: on `win32`, returns `\\.\pipe\<app>` (no name) / `\\.\pipe\<name>` (with name); override with no name returns the override verbatim. The POSIX length guard does not run on `win32`.

- [ ] **Step 1: Write the failing test**

Append to `packages/env/test/paths.test.ts` (reuse the `setPlatform` helper — if the Task 4 `describe` defined it locally, add a shared helper at file top or redefine here):

```ts
describe('getSocketPath on win32', () => {
  const realPlatform = process.platform
  const setPlatform = (value: string) =>
    Object.defineProperty(process, 'platform', { value, configurable: true })
  afterEach(() => setPlatform(realPlatform))

  test('returns an app-named pipe', () => {
    setPlatform('win32')
    expect(getSocketPath('myapp')).toBe('\\\\.\\pipe\\myapp')
  })
  test('returns a named pipe', () => {
    setPlatform('win32')
    expect(getSocketPath('myapp', 'monitor')).toBe('\\\\.\\pipe\\monitor')
  })
  test('honors an override with no name', () => {
    setPlatform('win32')
    process.env.MYAPP_SOCKET_PATH = '\\\\.\\pipe\\custom'
    expect(getSocketPath('myapp')).toBe('\\\\.\\pipe\\custom')
  })
  test('does not apply the posix length guard', () => {
    setPlatform('win32')
    expect(getSocketPath('myapp', 'x'.repeat(200))).toBe(`\\\\.\\pipe\\${'x'.repeat(200)}`)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk proxy pnpm --filter @tejika/env exec vitest run test/paths.test.ts -t "win32"`
Expected: FAIL — returns a `.sock` file path, not a pipe.

- [ ] **Step 3: Write minimal implementation**

In `getSocketPath`, after the `assertNoSeparator` calls and reading `override`, add the win32 branch BEFORE the POSIX path logic:

```ts
  const override = getAppEnvVar(app, 'SOCKET_PATH')
  if (process.platform === 'win32') {
    if (override != null && name == null) {
      return override
    }
    return `\\\\.\\pipe\\${name == null ? app : name}`
  }
```

The POSIX block (path computation + `assertSocketPathLength`) follows unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk proxy pnpm --filter @tejika/env exec vitest run test/paths.test.ts`
Expected: PASS (win32 + all POSIX tests still green).

- [ ] **Step 5: Commit**

```bash
git add packages/env/src/paths.ts packages/env/test/paths.test.ts
git commit -m "feat(env): return named pipes for sockets on win32"
```

---

### Task 6: Doc comments + architecture.md Windows/socket notes

**Files:**
- Modify: `packages/env/src/paths.ts` (doc comments only)
- Modify: `packages/env/src/env-var.ts` (doc comment only — the trim behavior is already coded)
- Modify: `docs/agents/architecture.md`

**Interfaces:**
- Consumes/Produces: none (documentation only).

- [ ] **Step 1: Clarify the `getStateDir` doc comment**

In `packages/env/src/paths.ts`, add above `getStateDir`:

```ts
/**
 * Config directory (`envPaths(app).config`). `env-paths` has no state bucket, and its
 * `log` bucket is `~/Library/Logs` on macOS rather than a state dir, so the pidfile
 * lives here by design. Returns `<APP>_STATE_DIR` when set.
 */
```

- [ ] **Step 2: Document the override/name rule on `getSocketPath`**

In `packages/env/src/paths.ts`, add above `getSocketPath`:

```ts
/**
 * IPC endpoint for `app` (optionally a named sub-socket). On POSIX a `.sock` path under
 * the data dir; on win32 a `\\.\pipe\<name>` named pipe. The `<APP>_SOCKET_PATH` override
 * is a directory anchor: with a `name` the socket is derived from `dirname(override)`;
 * with no `name` the override is used verbatim. `app`/`name` may not contain a path
 * separator or `..`. On POSIX an over-length path throws (`sun_path` is 104/108 bytes).
 */
```

- [ ] **Step 3: Document override trimming on `getAppEnvVar`**

In `packages/env/src/env-var.ts`, extend the existing `getAppEnvVar` doc comment to note the returned value is trimmed (append one sentence): "The returned value is trimmed of surrounding whitespace."

- [ ] **Step 4: Update architecture.md**

In `docs/agents/architecture.md`, under the `@tejika/env` description (or a nearby platform-notes location), add a short note:

```markdown
`@tejika/env` sockets are POSIX unix-domain `.sock` files (guarded against the
`sun_path` 104/108-byte limit) and Windows named pipes (`\\.\pipe\<name>`) —
`getSocketPath` branches on platform, so `@tejika/process` runs on both.
```

- [ ] **Step 5: Verify build + lint, then commit**

Run: `rtk proxy pnpm --filter @tejika/env exec vitest run` then `rtk lint biome`
Expected: all green, no lint diffs.

```bash
git add packages/env/src/paths.ts packages/env/src/env-var.ts docs/agents/architecture.md
git commit -m "docs(env): document socket rules, state dir, and trimming"
```

---

### Task 7: Full build + test + lint sweep

**Files:** none (verification).

- [ ] **Step 1: Build**

Run: `rtk proxy pnpm build`
Expected: types + JS build clean (confirms `@tejika/process` and `@tejika/cli` still typecheck against `@tejika/env`).

- [ ] **Step 2: Test**

Run: `rtk proxy pnpm test`
Expected: all packages green.

- [ ] **Step 3: Lint**

Run: `rtk lint biome`
Expected: no diffs.

- [ ] **Step 4: Commit (only if the sweep required a fixup)**

```bash
git add -A
git commit -m "chore(env): build/lint fixups for path hardening"
```

---

## Self-Review

**Spec coverage:**
- Windows named pipes → Task 5. Length guard → Task 4. Override/name derivation → Task 3. Separator rejection → Task 2. Digit-leading app → Task 1. `getStateDir` doc + trim doc + architecture.md → Task 6. Build/test/lint acceptance → Task 7. All spec §Changes items and Acceptance bullets covered.
- Spec "README" bullet: no env README exists; documented in architecture.md (Task 6) — deviation recorded in Global Constraints.

**Placeholder scan:** No TBD/TODO; every code step carries real code.

**Type consistency:** `assertNoSeparator(value, label)`, `assertSocketPathLength(app, path)`, `appEnvVar(app, key)` used consistently. `dirname`/`join` from `node:path`; `appEnvVar`/`getAppEnvVar` from `./env-var.js`. `getSocketPath` final shape: sanitize → read override → win32 branch → POSIX derive → guard → return, consistent across Tasks 2–5.
