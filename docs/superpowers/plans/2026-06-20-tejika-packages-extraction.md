# Tejika Packages Extraction & Mokei Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Precondition (gate):** The scaffold + conventions plan (`2026-06-20-tejika-scaffold-and-conventions.md`) is complete — workspace builds, `@tejika/env` exists with `appEnvVar`, and `docs/agents/` + `.claude/skills/` are present. Do **not** start this plan until that gate passes.

**Goal:** Build out the five `@tejika/*` packages by extracting and generalizing the mature implementations from Mokei (donor), then migrate Mokei to consume `@tejika/*` and delete the duplicated code.

**Architecture:** Each package is seeded from specific Mokei (and one Sakui) source files. Extraction = relocate the existing code, replace app-specific constants (socket paths, app name, log paths) with an `app: string` parameter + options resolved through `@tejika/env`, and keep the Enkaku wiring intact. Mokei becomes the first consumer, proving the APIs.

**Tech Stack:** Enkaku `^0.17` (client/server/socket-transport/http-server-transport), nano-spawn, Hono + @hono/node-server, get-port, commander `^15`, ink `^7.1`, @inkjs/ui `^2`, react `^19.2`, vitest, node-pty + strip-ansi.

## Global Constraints

(Identical to the scaffold plan — every task inherits these.)

- pnpm only; `type`/`Array<T>`/no-`any`; ES `#field` not `private`/`readonly`; capitalized abbreviations.
- Every package: `type: module`, `main: lib/index.js`, `types: lib/index.d.ts`, `exports`, `files: ["lib/*"]`, `sideEffects: false`. Build scripts identical to `@tejika/env` (swc `build:js`, tsc `build:types`, vitest `test:unit`).
- Shared deps via `catalog:` / `workspace:^` only. Catalog keys already seeded in the scaffold plan.
- **Depend on Enkaku directly** — do not add a transport-agnostic abstraction layer (YAGNI).
- **`app: string` parameter** is the generalization seam everywhere a Mokei/Sakui constant baked in `~/.mokei`/`~/.sakui`, the socket path, the pidfile, or the log path.
- Preserve all of Mokei `host-monitor`'s security defenses verbatim (Host allowlist, Origin allowlist, timing-safe Bearer token, socket `chmod 0o600`).

**Donor source map (read these in the sibling repos):**
- `@tejika/env` ← `../sakui/apps/cli/src/paths.ts` + Mokei `get-port` usage
- `@tejika/process` ← `../mokei/packages/host/src/daemon/{controller,process}.ts`, `../mokei/packages/host/src/server.ts`, `../mokei/packages/host/src/spawn.ts` + `../sakui/apps/cli/src/daemon/{controller,lifecycle,process}.ts`
- `@tejika/server` ← `../mokei/packages/host-monitor/src/{index,auth,html,pipes}.ts`
- `@tejika/cli` ← `../mokei/packages/cli/src/{program,ink,options}.ts`
- `@tejika/ui` ← `../mokei/packages/cli/src/chat/components/*.tsx`

---

### Task 1: `@tejika/env` — full path/port/env resolution

Extends the `appEnvVar` util from the scaffold plan into the full resolver set.

**Files:**
- Create: `packages/env/src/paths.ts`, `packages/env/src/ports.ts`
- Modify: `packages/env/src/index.ts`
- Test: `packages/env/test/paths.test.ts`, `packages/env/test/ports.test.ts`

**Interfaces:**
- Consumes: `appEnvVar(app, key)` from `./env-var.js`; `env-paths`; `get-port`.
- Produces:
  - `getDataDir(app: string): string`
  - `getStateDir(app: string): string`
  - `getSocketPath(app: string, name?: string): string`
  - `getPidPath(app: string): string`
  - `getPort(app: string, opts?: { default?: number }): Promise<number>`
  - Env override precedence (checked first): `<APP>_DATA_DIR`, `<APP>_STATE_DIR`, `<APP>_SOCKET_PATH`, `<APP>_PID_PATH`, `<APP>_PORT` (via `appEnvVar`).

- [ ] **Step 1: Write failing tests for path resolution + env override**

`packages/env/test/paths.test.ts`:
```ts
import { afterEach, describe, expect, test } from 'vitest'
import { getDataDir, getSocketPath } from '../src/paths.js'

afterEach(() => {
  delete process.env.MYAPP_DATA_DIR
  delete process.env.MYAPP_SOCKET_PATH
})

describe('getDataDir', () => {
  test('returns a deterministic per-app data dir', () => {
    expect(getDataDir('myapp')).toMatch(/myapp/)
  })
  test('honors the env override first', () => {
    process.env.MYAPP_DATA_DIR = '/tmp/custom-data'
    expect(getDataDir('myapp')).toBe('/tmp/custom-data')
  })
})

describe('getSocketPath', () => {
  test('derives a socket path under the data dir', () => {
    expect(getSocketPath('myapp')).toMatch(/myapp.*\.sock$/)
  })
  test('honors the env override first', () => {
    process.env.MYAPP_SOCKET_PATH = '/tmp/custom.sock'
    expect(getSocketPath('myapp')).toBe('/tmp/custom.sock')
  })
  test('supports a named socket', () => {
    expect(getSocketPath('myapp', 'monitor')).toMatch(/monitor\.sock$/)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm --filter @tejika/env exec vitest run test/paths.test.ts`
Expected: FAIL — `../src/paths.js` not found.

- [ ] **Step 3: Implement `paths.ts`**

Relocate the path logic from `../sakui/apps/cli/src/paths.ts`, replacing the hardcoded `sakui` app constant with the `app` parameter and resolving the base dir through `env-paths`. Each resolver checks its `appEnvVar(app, KEY)` override first.

```ts
import { join } from 'node:path'
import envPaths from 'env-paths'
import { appEnvVar } from './env-var.js'

export function getDataDir(app: string): string {
  return process.env[appEnvVar(app, 'DATA_DIR')] ?? envPaths(app, { suffix: '' }).data
}

export function getStateDir(app: string): string {
  return process.env[appEnvVar(app, 'STATE_DIR')] ?? envPaths(app, { suffix: '' }).config
}

export function getSocketPath(app: string, name?: string): string {
  const override = process.env[appEnvVar(app, 'SOCKET_PATH')]
  if (override != null && name == null) return override
  const file = name == null ? `${app}.sock` : `${name}.sock`
  return join(getDataDir(app), file)
}

export function getPidPath(app: string): string {
  return process.env[appEnvVar(app, 'PID_PATH')] ?? join(getStateDir(app), `${app}.pid`)
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm --filter @tejika/env exec vitest run test/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing test for `getPort` + implement**

`packages/env/test/ports.test.ts`:
```ts
import { afterEach, describe, expect, test } from 'vitest'
import { getPort } from '../src/ports.js'

afterEach(() => {
  delete process.env.MYAPP_PORT
})

describe('getPort', () => {
  test('returns the env override when set', async () => {
    process.env.MYAPP_PORT = '7777'
    await expect(getPort('myapp')).resolves.toBe(7777)
  })
  test('falls back to an available port', async () => {
    const port = await getPort('myapp', { default: 4000 })
    expect(port).toBeGreaterThan(0)
  })
})
```

`packages/env/src/ports.ts`:
```ts
import getAvailablePort from 'get-port'
import { appEnvVar } from './env-var.js'

export async function getPort(app: string, opts: { default?: number } = {}): Promise<number> {
  const override = process.env[appEnvVar(app, 'PORT')]
  if (override != null) return Number.parseInt(override, 10)
  return getAvailablePort(opts.default == null ? undefined : { port: opts.default })
}
```

- [ ] **Step 6: Update `index.ts` barrel + run full package gate**

`packages/env/src/index.ts`:
```ts
export { appEnvVar } from './env-var.js'
export { getDataDir, getStateDir, getSocketPath, getPidPath } from './paths.js'
export { getPort } from './ports.js'
```

Run: `pnpm --filter @tejika/env test && pnpm --filter @tejika/env build`
Expected: all tests PASS, build emits `lib/*`.

- [ ] **Step 7: Commit**

```bash
git add packages/env pnpm-lock.yaml
git commit -m "feat(env): full path/port resolution with env overrides"
```

---

### Task 2: `@tejika/process` — daemon lifecycle + Enkaku client

**Files:**
- Create: `packages/process/package.json`, `tsconfig.json`
- Create: `packages/process/src/{index,daemon,controller,client,status}.ts`
- Test: `packages/process/test/daemon.test.ts`

**Interfaces:**
- Consumes: `@tejika/env` (`getSocketPath`, `getPidPath`, `getDataDir`); `@enkaku/socket-transport`, `@enkaku/client`, `@enkaku/server`; `nano-spawn`.
- Produces:
  - `runDaemon(opts: { app: string; socketPath?: string; pidPath?: string; serve: (transport) => Server; onShutdown?: () => Promise<void> }): Promise<void>`
  - `spawnDaemon(opts: { app: string; entry: string; args?: Array<string>; socketPath?: string; logPath?: string }): Promise<void>`
  - `createDaemonClient<Protocol>(opts: { app: string; socketPath?: string; protocol: Protocol }): Client<Protocol>` (reconnect backoff 250ms–5s)
  - `ensureDaemon<Protocol>(opts): Promise<Client<Protocol>>` (connect, else spawn + retry)
  - `getDaemonStatus(opts: { app: string; pidPath?: string }): { running: boolean; pid?: number; stale: boolean }`
  - `stopDaemon(opts: { app: string; pidPath?: string }): Promise<void>`

- [ ] **Step 1: Create package.json + tsconfig**

`packages/process/package.json` — clone `@tejika/env`'s package.json shape; set `name` to `@tejika/process`; dependencies:
```json
"dependencies": {
  "@enkaku/client": "catalog:",
  "@enkaku/server": "catalog:",
  "@enkaku/socket-transport": "catalog:",
  "@tejika/env": "workspace:^",
  "nano-spawn": "catalog:"
},
"devDependencies": { "@types/node": "catalog:" }
```
`packages/process/tsconfig.json` — identical to `packages/env/tsconfig.json`.

- [ ] **Step 2: Write failing integration test (status + spawn + reconnect)**

`packages/process/test/daemon.test.ts`:
```ts
import { afterEach, describe, expect, test } from 'vitest'
import { getDaemonStatus, stopDaemon } from '../src/status.js'

const APP = 'tejika-test'

afterEach(async () => {
  await stopDaemon({ app: APP }).catch(() => {})
})

describe('getDaemonStatus', () => {
  test('reports not-running when no pidfile exists', () => {
    const status = getDaemonStatus({ app: APP, pidPath: '/tmp/tejika-test-absent.pid' })
    expect(status.running).toBe(false)
    expect(status.stale).toBe(false)
  })
})
```
(Spawn/reconnect coverage is added once the daemon entry helper is in place — see Step 5.)

- [ ] **Step 3: Implement `status.ts`**

Relocate `getDaemonStatus`/`stopDaemon` from `../sakui/apps/cli/src/daemon/controller.ts:205+` (pidfile read, `process.kill(pid, 0)` existence probe, stale reap) and `../mokei/packages/host/src/daemon/controller.ts`. Replace the Sakui-specific pid path with `opts.pidPath ?? getPidPath(opts.app)`.

```ts
import { readFileSync, rmSync } from 'node:fs'
import { getPidPath } from '@tejika/env'

export type DaemonStatus = { running: boolean; pid?: number; stale: boolean }

export function getDaemonStatus(opts: { app: string; pidPath?: string }): DaemonStatus {
  const pidPath = opts.pidPath ?? getPidPath(opts.app)
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
  } catch {
    return { running: false, stale: false }
  }
  try {
    process.kill(pid, 0)
    return { running: true, pid, stale: false }
  } catch {
    rmSync(pidPath, { force: true })
    return { running: false, pid, stale: true }
  }
}

export async function stopDaemon(opts: { app: string; pidPath?: string }): Promise<void> {
  const status = getDaemonStatus(opts)
  if (status.running && status.pid != null) process.kill(status.pid, 'SIGTERM')
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm --filter @tejika/process exec vitest run`
Expected: PASS.

- [ ] **Step 5: Implement `daemon.ts` (runDaemon/spawnDaemon), `controller.ts` (ensureDaemon), `client.ts` (createDaemonClient)**

Relocate from the donor files, generalizing every app constant to `opts.app` + `@tejika/env`:
- `daemon.ts` ← Mokei `host/src/daemon/process.ts` + `host/src/server.ts:162-204` (`net.Server` on `socketPath`, `chmod 0o600`, SIGINT/SIGTERM cleanup, pidfile write) and Sakui `daemon/lifecycle.ts`. `runDaemon` binds the socket and calls `opts.serve(transport)` per connection.
- `spawnDaemon` ← Mokei `host/src/daemon/controller.ts:29-61` + Sakui `daemon/controller.ts:99` — `nano-spawn` detached, stdio → `opts.logPath ?? join(getDataDir(app), 'daemon.log')`, readiness poll on the socket, `child.unref()`.
- `controller.ts` `ensureDaemon` ← Sakui `daemon/controller.ts:158` — try connect; on `ECONNREFUSED`/`ENOENT` call `spawnDaemon` then retry.
- `client.ts` `createDaemonClient` ← Sakui `daemon/controller.ts:35-57` — `SocketTransport` + reconnecting source, exponential backoff 250ms–5s, returns an `@enkaku/client` `Client<Protocol>`.

Add a spawn/reconnect integration test that boots a trivial daemon entry, asserts `getDaemonStatus(...).running === true` after `ensureDaemon`, kills it, and asserts the client reconnects. Use a temp socket path under `/tmp`.

`packages/process/src/index.ts`:
```ts
export { runDaemon, spawnDaemon } from './daemon.js'
export { ensureDaemon } from './controller.js'
export { createDaemonClient } from './client.js'
export { getDaemonStatus, stopDaemon, type DaemonStatus } from './status.js'
```

- [ ] **Step 6: Run package gate + commit**

Run: `pnpm --filter @tejika/process test && pnpm --filter @tejika/process build`
Expected: PASS, `lib/*` emitted.

```bash
git add packages/process pnpm-lock.yaml
git commit -m "feat(process): daemon lifecycle, spawn, reconnecting client"
```

---

### Task 3: `@tejika/server` — local HTTP with access control

**Files:**
- Create: `packages/server/package.json`, `tsconfig.json`
- Create: `packages/server/src/{index,server,auth,static}.ts`
- Test: `packages/server/test/auth.test.ts`, `packages/server/test/server.test.ts`

**Interfaces:**
- Consumes: `@tejika/env` (`getPort`); `@enkaku/http-server-transport`; `hono`, `@hono/node-server`.
- Produces:
  - `type AuthConfig = { mode: 'token' } | { mode: 'custom'; verify: (req: Request) => boolean }`
  - `createLocalServer(opts: { app: string; bind?: 'loopback' | 'network'; port?: number; allowedOrigin?: string; auth?: AuthConfig }): Promise<{ app: Hono; url: string; token?: string; close: () => Promise<void> }>` — default `bind: 'loopback'`.
  - `buildAllowedHosts(port: number): Set<string>` (loopback aliases + port)
  - `verifyLoopbackRequest(req: Request, ctx: { allowedHosts: Set<string>; allowedOrigins: Set<string>; token: string }): boolean`
  - `attachEnkakuTransport(server: Hono, opts: { path: string }): Transport`
  - `serveStaticSPA(server: Hono, opts: { dir: string; token: string }): void`

- [ ] **Step 1: Create package.json + tsconfig**

dependencies:
```json
"dependencies": {
  "@enkaku/http-server-transport": "catalog:",
  "@hono/node-server": "catalog:",
  "@tejika/env": "workspace:^",
  "get-port": "catalog:",
  "hono": "catalog:"
},
"devDependencies": { "@types/node": "catalog:" }
```

- [ ] **Step 2: Write failing auth tests (accept + reject matrix)**

`packages/server/test/auth.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { buildAllowedHosts, verifyLoopbackRequest } from '../src/auth.js'

const ctx = {
  allowedHosts: buildAllowedHosts(8080),
  allowedOrigins: new Set(['http://127.0.0.1:8080']),
  token: 'secret-token',
}

function req(headers: Record<string, string>): Request {
  return new Request('http://127.0.0.1:8080/api', { headers })
}

describe('verifyLoopbackRequest', () => {
  test('accepts matching Host + Origin + Bearer token', () => {
    expect(verifyLoopbackRequest(req({
      host: '127.0.0.1:8080',
      origin: 'http://127.0.0.1:8080',
      authorization: 'Bearer secret-token',
    }), ctx)).toBe(true)
  })
  test('rejects a foreign Host (DNS rebinding)', () => {
    expect(verifyLoopbackRequest(req({
      host: 'evil.example.com',
      authorization: 'Bearer secret-token',
    }), ctx)).toBe(false)
  })
  test('rejects a foreign Origin (CSRF)', () => {
    expect(verifyLoopbackRequest(req({
      host: '127.0.0.1:8080',
      origin: 'http://evil.example.com',
      authorization: 'Bearer secret-token',
    }), ctx)).toBe(false)
  })
  test('rejects a wrong token', () => {
    expect(verifyLoopbackRequest(req({
      host: '127.0.0.1:8080',
      authorization: 'Bearer wrong',
    }), ctx)).toBe(false)
  })
})
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `pnpm --filter @tejika/server exec vitest run test/auth.test.ts`
Expected: FAIL — `../src/auth.js` not found.

- [ ] **Step 4: Implement `auth.ts`**

Relocate verbatim from `../mokei/packages/host-monitor/src/auth.ts` (`buildAllowedHosts`, `verifyAPIRequest` → renamed `verifyLoopbackRequest`). Keep the timing-safe `crypto.timingSafeEqual` token comparison and the "no Origin ⇒ non-browser ⇒ allow" rule exactly. No app-specific changes needed.

- [ ] **Step 5: Run tests, verify they pass**

Run: `pnpm --filter @tejika/server exec vitest run test/auth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Implement `server.ts` + `static.ts`, write a server integration test**

`server.ts` ← `../mokei/packages/host-monitor/src/index.ts:43-88` (`startMonitor`), generalized:
- `bind: 'loopback'` (default) → bind `127.0.0.1`, generate random 256-bit hex token, gate `/api` via `verifyLoopbackRequest`.
- `bind: 'network'` → bind `0.0.0.0`, apply CORS from `allowedOrigin` (default `*`), use `auth.mode === 'custom'` verify hook instead of the token gate.
- `port` resolved via `opts.port ?? getPort(opts.app)`.
- `attachEnkakuTransport` ← wiring from `host-monitor/src/pipes.ts` + `@enkaku/http-server-transport`.

`static.ts` ← `host-monitor/src/html.ts` `injectToken` + SPA fallback (`index.ts:54,66`).

`server.test.ts`: start a loopback server, assert a request with the correct Host+token to `/api` returns non-401, and a request with a foreign Host returns 401/403. Close the server in `afterEach`.

`packages/server/src/index.ts`:
```ts
export { createLocalServer, type AuthConfig } from './server.js'
export { buildAllowedHosts, verifyLoopbackRequest } from './auth.js'
export { serveStaticSPA } from './static.js'
```

- [ ] **Step 7: Run package gate + commit**

Run: `pnpm --filter @tejika/server test && pnpm --filter @tejika/server build`
Expected: PASS, `lib/*` emitted.

```bash
git add packages/server pnpm-lock.yaml
git commit -m "feat(server): local Hono server with loopback + network modes"
```

---

### Task 4: `@tejika/cli` — commander + Ink plumbing

**Files:**
- Create: `packages/cli/package.json`, `tsconfig.json`
- Create: `packages/cli/src/{index,program,ink,options}.ts`
- Test: `packages/cli/test/options.test.ts`, `packages/cli/test/program.integration.test.ts`

**Interfaces:**
- Consumes: `commander`, `ink`, `react`; `@tejika/env` (option defaults).
- Produces:
  - `buildProgram(opts: { name: string; version: string; commands: Array<Command> }): Command`
  - `runInk(element: ReactElement): Promise<void>`
  - `renderStatic(element: ReactElement): void`
  - `withSocketPath(cmd: Command, app: string): Command`
  - `withPort(cmd: Command, app: string): Command`
  - `withLogLevel(cmd: Command): Command`

- [ ] **Step 1: Create package.json + tsconfig**

dependencies:
```json
"dependencies": {
  "@tejika/env": "workspace:^",
  "commander": "catalog:",
  "ink": "catalog:",
  "react": "catalog:"
},
"devDependencies": {
  "@types/node": "catalog:",
  "@types/react": "catalog:",
  "ink-testing-library": "catalog:",
  "strip-ansi": "catalog:"
}
```
`tsconfig.json` — same as env's, plus `"jsx": "react-jsx"` in compilerOptions.

- [ ] **Step 2: Write failing unit test for an option builder**

`packages/cli/test/options.test.ts`:
```ts
import { Command } from 'commander'
import { describe, expect, test } from 'vitest'
import { withLogLevel } from '../src/options.js'

describe('withLogLevel', () => {
  test('registers a --log-level option with a default', () => {
    const cmd = withLogLevel(new Command())
    const opt = cmd.options.find((o) => o.long === '--log-level')
    expect(opt).toBeDefined()
    expect(opt?.defaultValue).toBe('warning')
  })
})
```

- [ ] **Step 3: Run, verify fail; implement `options.ts` + `program.ts` + `ink.ts`**

Relocate from `../mokei/packages/cli/src/options.ts` (`withSocketPath`, `withChatOptions` → keep the generic `withSocketPath`/`withPort`/`withLogLevel`, parameterized by `app` and defaulting through `@tejika/env`), `program.ts` (`buildProgram` wrapper around commander), and `ink.ts` (`runInk`/`renderStatic` around Ink `render`).

`withSocketPath`/`withPort` defaults call `getSocketPath(app)` / `getPort(app)` lazily (only when the option is unset at action time, not at registration — keep registration synchronous).

`packages/cli/src/index.ts`:
```ts
export { buildProgram } from './program.js'
export { runInk, renderStatic } from './ink.js'
export { withSocketPath, withPort, withLogLevel } from './options.js'
```

Run: `pnpm --filter @tejika/cli exec vitest run test/options.test.ts`
Expected: PASS.

- [ ] **Step 4: Write a PTY integration test for a built program**

`packages/cli/test/program.integration.test.ts`: build a tiny program via `buildProgram` exposing a `--version` flag, render through `node-pty`, strip ANSI, assert the version string appears. (Mirror Sakui's `node-pty` + `strip-ansi` CLI test pattern.)

- [ ] **Step 5: Run package gate + commit**

Run: `pnpm --filter @tejika/cli test && pnpm --filter @tejika/cli build`
Expected: PASS, `lib/*` emitted.

```bash
git add packages/cli pnpm-lock.yaml
git commit -m "feat(cli): commander + ink plumbing and option builders"
```

---

### Task 5: `@tejika/ui` — generic Ink component kit

**Files:**
- Create: `packages/ui/package.json`, `tsconfig.json`
- Create: `packages/ui/src/index.ts` + one file per component under `packages/ui/src/`
- Test: `packages/ui/test/StatusLine.test.tsx`, `packages/ui/test/ConfirmCard.test.tsx`

**Interfaces:**
- Consumes: `ink`, `@inkjs/ui`, `react`.
- Produces (initial set, each a default + named export): `StatusLine`, `Footer`, `KeyHints`, `ConfirmCard`, `SelectCard`, `Spinner`, `IconLine`, `SystemNotice`.

- [ ] **Step 1: Create package.json + tsconfig**

dependencies: `ink`, `@inkjs/ui`, `react` (all `catalog:`); devDeps `@types/react`, `ink-testing-library`. `tsconfig.json` with `"jsx": "react-jsx"`.

- [ ] **Step 2: Write a failing component test**

`packages/ui/test/StatusLine.test.tsx`:
```tsx
import { render } from 'ink-testing-library'
import { describe, expect, test } from 'vitest'
import { StatusLine } from '../src/StatusLine.js'

describe('StatusLine', () => {
  test('renders the provided label', () => {
    const { lastFrame } = render(<StatusLine label="ready" />)
    expect(lastFrame()).toContain('ready')
  })
})
```

- [ ] **Step 3: Run, verify fail; extract components from Mokei**

Extract from `../mokei/packages/cli/src/chat/components/*.tsx`, stripping chat-domain props:
- `StatusLine` ← `StatusLine.tsx` (keep label/icon/colour props; drop session-specific props)
- `Footer`/`KeyHints` ← `Footer.tsx` + `IconLine.tsx`
- `ConfirmCard` ← `ConfirmCard.tsx`
- `SelectCard` ← `ProviderSelectCard.tsx`/`ModelSelectCard.tsx` generalized to `{ items, onSelect }`
- `Spinner` ← `WaitingStatus.tsx`/`PendingTurn.tsx`
- `SystemNotice` ← `SystemNotice.tsx`

Each component: pure presentational, props-only, no imports from `@mokei/*`. Add a test per component asserting it renders its key prop.

`packages/ui/src/index.ts` re-exports all components.

Run: `pnpm --filter @tejika/ui exec vitest run`
Expected: PASS.

- [ ] **Step 4: Run package gate + commit**

Run: `pnpm --filter @tejika/ui test && pnpm --filter @tejika/ui build`
Expected: PASS, `lib/*` emitted.

```bash
git add packages/ui pnpm-lock.yaml
git commit -m "feat(ui): generic Ink component kit"
```

---

### Task 6: Migrate Mokei to consume `@tejika/*`

Mokei is the first consumer. This proves the APIs and deletes the duplicated code. Performed in the `../mokei` repo (not `tejika`).

**Files (in `../mokei`):**
- Modify: `packages/host/package.json`, `packages/host-monitor/package.json`, `packages/cli/package.json` — add `@tejika/*` deps. Since tejika is a separate repo, link via the published `catalog:`/`workspace` mechanism Mokei uses for cross-repo deps (confirm with the user whether to consume via local `link:` during development or a published version).
- Modify: `packages/host/src/daemon/*`, `server.ts`, `spawn.ts` — replace relocated logic with imports from `@tejika/process`.
- Modify: `packages/host-monitor/src/{index,auth,html}.ts` — replace with imports from `@tejika/server`.
- Modify: `packages/cli/src/{program,ink,options}.ts` + `chat/components/*` — import plumbing from `@tejika/cli` and generic components from `@tejika/ui`; keep chat-domain components local.

**Interfaces:**
- Consumes: all five `@tejika/*` public APIs from Tasks 1–5.
- Produces: a Mokei that builds, lints, and tests green with the duplicated implementations removed.

- [ ] **Step 1: Confirm the cross-repo linking strategy with the user**

tejika is a separate repo from Mokei. Decide: local `link:../tejika/packages/*` (dev) vs publishing `@tejika/*` to the registry and pinning via catalog. Do not proceed until chosen — this affects every package.json edit below.

- [ ] **Step 2: Repoint `@mokei/host` to `@tejika/process` + `@tejika/env`**

Add the deps; replace `daemon/controller.ts`, `daemon/process.ts`, the socket-server block in `server.ts`, and `spawn.ts` daemon bits with `@tejika/process` imports. Delete the now-dead local code.

Run: `pnpm --filter @mokei/host test`
Expected: PASS (existing host tests still green against the extracted impl).

- [ ] **Step 3: Repoint `@mokei/host-monitor` to `@tejika/server`**

Replace `auth.ts`/`index.ts` server-construction with `createLocalServer(...)` + `serveStaticSPA(...)`. Keep the monitor's host-protocol wiring.

Run: `pnpm --filter @mokei/host-monitor test`
Expected: PASS.

- [ ] **Step 4: Repoint `@mokei/cli` to `@tejika/cli` + `@tejika/ui`**

Replace `program.ts`/`ink.ts`/`options.ts` with `@tejika/cli` imports; swap generic chat components for `@tejika/ui` equivalents; leave chat-domain components (AssistantMessage, ToolApprovalCard, etc.) in place.

Run: `pnpm --filter @mokei/cli test`
Expected: PASS.

- [ ] **Step 5: Full Mokei verification + commit**

Run: `pnpm build && pnpm test && pnpm lint` (in `../mokei`)
Expected: all green.

```bash
# in ../mokei
git add -A
git commit -m "refactor: consume @tejika/* for cli, process, and local server"
```

---

## Self-Review

- **Spec coverage:** Task 1 = `@tejika/env` (spec pkg 1). Task 2 = `@tejika/process` (pkg 2). Task 3 = `@tejika/server`, both bind modes + security defenses (pkg 3 + Security notes). Task 4 = `@tejika/cli` (pkg 4). Task 5 = `@tejika/ui` (pkg 5). Task 6 = Mokei migration / first consumer (spec P2 + "Mokei depends back"). Sakui (P3) and Kubun (P4) are explicitly out of scope per the spec.
- **Donor refs:** every extraction task names exact sibling-repo source files; the executor reads them in context (the implementation is relocate + parameterize, not green-field).
- **Type consistency:** `app: string` is the uniform generalization seam; `getSocketPath`/`getPidPath`/`getPort` signatures defined in Task 1 match their consumption in Tasks 2–4; `verifyLoopbackRequest`/`buildAllowedHosts` defined and consumed within Task 3; `createLocalServer` signature consistent between its Interfaces block and Task 6 Step 3 usage.
- **Placeholders:** test code is complete and concrete. Implementation steps that relocate large existing modules cite exact donor files plus the target signature and the specific generalization delta, rather than fabricating verbatim bodies that exist in the donor repos — appropriate for an extraction/refactor plan.
- **Open item surfaced, not buried:** Task 6 Step 1 forces the cross-repo linking decision (local `link:` vs published) before any Mokei package.json edit.
