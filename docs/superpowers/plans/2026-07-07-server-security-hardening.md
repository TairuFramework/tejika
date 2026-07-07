# Server Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** qa
**Mode:** tasks

**Goal:** Close the gate-scope and network-mode-auth holes in `@tejika/server` (audit H1, H2 + `@tejika/server` mediums/lows) without rewriting the loopback crypto mechanism.

**Architecture:** Loopback mode gets a global Host allowlist gate (`app.use('*', …)`) so the token-injected SPA index is never served to a foreign Host, while the full token/Origin gate stays on `/api`. Network mode throws at creation unless a `custom` auth verifier is supplied, and swaps hand-rolled CORS for Hono's `cors()` middleware. `serve()` is awaited so bind errors reject instead of crashing later. `static.ts` uses an absolute root and scopes its SPA fallback off `/api`.

**Tech Stack:** TypeScript (ESM), Hono 4 + `@hono/node-server` 2, Vitest, Node `node:crypto`/`node:net`.

## Global Constraints

- No `interface` — use `type`. No `T[]` — use `Array<T>`. No `any` — use `unknown` / specific types.
- No lowercase abbreviations in names (`ID`, `HTTP`, `JWT`). No TS `private`/`readonly` — ES `#fields` + getters.
- `pnpm` only. Never edit generated `lib/`. Never work around `@enkaku/*` bugs.
- Lint/format via Biome: run `rtk lint biome` (the `rtk`/`pnpm run` shim otherwise routes to eslint).
- Do NOT rewrite the loopback crypto (256-bit token, `timingSafeEqual`, fail-closed Origin, exact-match Sets, `injectToken` escaping). Fix scope and defaults only.
- All work is in `packages/server/`. Test with `pnpm --filter @tejika/server test`.

---

### Task 1: Harden `static.ts` — token-escape replacer, absolute root, scoped SPA fallback

**Files:**
- Modify: `packages/server/src/static.ts`
- Test: `packages/server/test/static.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `injectToken(html: string, token: string): string` (unchanged signature), `serveStaticSPA(app: Hono, opts: { dir: string; token: string }): void` (unchanged signature). After this task, `serveStaticSPA` mounts an absolute-root `serveStatic` and a `notFound` handler that returns a 404 for `/api*` paths and the SPA index otherwise.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/static.test.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { injectToken, serveStaticSPA } from '../src/static.js'

describe('injectToken', () => {
  test('injects the token as a JSON global inside head', () => {
    const out = injectToken('<html><head></head><body></body></html>', 'abc123')
    expect(out).toContain('<script>window.__APP_TOKEN__="abc123"</script></head>')
  })

  test('unicode-escapes < and > so a "</script>" token cannot break out', () => {
    const out = injectToken('<head></head>', '</script><script>alert(1)</script>')
    expect(out).not.toContain('</script><script>alert(1)')
    expect(out).toContain('\\u003c/script\\u003e')
  })

  test('does not expand a $&-style token via string replace', () => {
    const out = injectToken('<head></head>', 'a$&b')
    // A raw String.replace would turn $& into the matched "</head>"; the replacer must not.
    expect(out).toContain('window.__APP_TOKEN__="a$&b"')
    expect(out).not.toContain('a</head>b')
  })
})

describe('serveStaticSPA', () => {
  let dir: string
  let app: Hono
  const cwd = process.cwd()

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tejika-static-'))
    await writeFile(join(dir, 'index.html'), '<head></head><body>app</body>')
    await writeFile(join(dir, 'asset.txt'), 'hello-asset')
    app = new Hono()
  })

  afterEach(() => {
    process.chdir(cwd)
  })

  test('serves the token-injected index at /', async () => {
    serveStaticSPA(app, { dir, token: 'tok' })
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('window.__APP_TOKEN__="tok"')
  })

  test('serves assets from an absolute root even after chdir', async () => {
    serveStaticSPA(app, { dir, token: 'tok' })
    process.chdir(tmpdir()) // a daemon-style chdir must not re-point the static root
    const res = await app.request('/asset.txt')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello-asset')
  })

  test('returns 404 (not the SPA index) for an unknown /api path', async () => {
    serveStaticSPA(app, { dir, token: 'tok' })
    const res = await app.request('/api/does-not-exist')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('window.__APP_TOKEN__')
  })

  test('serves the SPA index for an unknown non-/api path', async () => {
    serveStaticSPA(app, { dir, token: 'tok' })
    const res = await app.request('/some/client/route')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('window.__APP_TOKEN__="tok"')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tejika/server exec vitest run test/static.test.ts`
Expected: FAIL — `$&` test and the `/api` 404 test fail against current `static.ts`; chdir test may fail depending on cwd.

- [ ] **Step 3: Rewrite `static.ts`**

Replace the whole file with:

```ts
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Context, Hono } from 'hono'

/**
 * Splice a secret token into served HTML as a global the SPA reads. The token is
 * JSON-encoded so a token value can never break out of the <script> element, and
 * `<`/`>` are unicode-escaped so even a pathological token containing
 * "</script>" cannot close the injected block. The head insertion uses a replacer
 * function so a `$&`/`$1`-style token cannot expand during String.replace.
 */
export function injectToken(html: string, token: string): string {
  const safeJSON = JSON.stringify(token).replace(/[<>]/g, (c) => (c === '<' ? '\\u003c' : '\\u003e'))
  const tag = `<script>window.__APP_TOKEN__=${safeJSON}</script>`
  return html.includes('</head>') ? html.replace('</head>', () => `${tag}</head>`) : `${tag}${html}`
}

/**
 * Serve a static SPA from `opts.dir`: the entry point and the non-`/api`
 * not-found fallback both return `index.html` with the token injected; real asset
 * files are served by `serveStatic`. The root is resolved to an absolute path so a
 * later `process.chdir` (common in daemons) cannot re-point or break serving, and
 * so cross-drive paths work on Windows. Unknown `/api/*` paths return a real 404
 * instead of the HTML index.
 */
export function serveStaticSPA(app: Hono, opts: { dir: string; token: string }): void {
  const root = resolve(opts.dir)
  const indexPath = join(root, 'index.html')
  const renderIndex = async (ctx: Context): Promise<Response> =>
    ctx.html(injectToken(await readFile(indexPath, 'utf8'), opts.token))
  app.get('/', renderIndex)
  app.use('/*', serveStatic({ root }))
  app.notFound((ctx) => (ctx.req.path.startsWith('/api') ? ctx.text('Not Found', 404) : renderIndex(ctx)))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tejika/server exec vitest run test/static.test.ts`
Expected: PASS (all `injectToken` + `serveStaticSPA` tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/static.ts packages/server/test/static.test.ts
git commit -m "fix(server): absolute static root, scoped SPA fallback, token replacer"
```

---

### Task 2: H1 — global Host gate in loopback so the token index rejects a foreign Host

**Files:**
- Modify: `packages/server/src/server.ts:45-65` (loopback branch)
- Test: `packages/server/test/server.test.ts`

**Interfaces:**
- Consumes: `buildAllowedHosts(port)` from `./auth.js`, `serveStaticSPA` from `./static.js` (Task 1).
- Produces: loopback `createLocalServer` registers `app.use('*', hostGate)` — a Host-allowlist-only middleware — before the `/api` token gate, so any route (incl. `/` and the SPA fallback) 403s on a non-allowlisted Host. `/api` keeps the full `verifyLoopbackRequest` gate.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/test/server.test.ts` inside the `describe('createLocalServer (loopback)')` block:

```ts
  test('rejects the token-bearing SPA index for a foreign Host (H1)', async () => {
    const server = await createLocalServer({ app: 'tejika-test' })
    close = server.close
    // The consuming app mounts a static SPA on the returned Hono app.
    serveStaticSPA(server.app, { dir: fixtureDir, token: server.token as string })
    const port = new URL(server.url).port

    // Good loopback Host: the index (with token) is served.
    const local = await server.app.request('/', { headers: { host: `127.0.0.1:${port}` } })
    expect(local.status).toBe(200)
    expect(await local.text()).toContain('window.__APP_TOKEN__')

    // DNS-rebinding page: foreign Host must never receive the token index.
    const foreign = await server.app.request('/', { headers: { host: 'evil.example.com' } })
    expect(foreign.status).toBe(403)
    expect(await foreign.text()).not.toContain('window.__APP_TOKEN__')
  })
```

At the top of `server.test.ts`, add the imports and a fixture dir (place near the other imports / above the `describe`s):

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveStaticSPA } from '../src/static.js'

const fixtureDir = mkdtempSync(join(tmpdir(), 'tejika-server-'))
writeFileSync(join(fixtureDir, 'index.html'), '<head></head><body>app</body>')
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tejika/server exec vitest run test/server.test.ts -t "foreign Host"`
Expected: FAIL — `foreign.status` is 200 (index served ungated); token leaks.

- [ ] **Step 3: Add the global Host gate to the loopback branch**

In `packages/server/src/server.ts`, in the `if (bind === 'loopback')` block, add a Host-only gate and register it on `'*'` before the `/api` gate. The loopback branch becomes:

```ts
  if (bind === 'loopback') {
    const token = randomBytes(32).toString('hex')
    const allowedHosts = buildAllowedHosts(port)
    // Mirror buildAllowedHosts' loopback aliases (incl. IPv6 [::1]) so a browser
    // on any loopback alias is accepted by the Origin check, not just the Host check.
    const allowedOrigins = new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
    ])
    // Global Host gate: the token-bearing SPA index is served at `/` and as the
    // SPA fallback, so the Host allowlist (the DNS-rebinding defense) must cover
    // every route, not just `/api`. Host match is case-sensitive by design
    // (fail-closed: an unexpected-case Host is treated as foreign).
    const hostGate = async (ctx: Context, next: Next): Promise<Response | undefined> => {
      const host = ctx.req.raw.headers.get('host')
      if (host == null || !allowedHosts.has(host)) return ctx.text('Forbidden', 403)
      await next()
    }
    app.use('*', hostGate)
    const gate = async (ctx: Context, next: Next): Promise<Response | undefined> => {
      if (!verifyLoopbackRequest(ctx.req.raw, { allowedHosts, allowedOrigins, token })) {
        return ctx.text('Forbidden', 403)
      }
      await next()
    }
    app.use('/api', gate)
    app.use('/api/*', gate)
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })
    return { app, url: `http://127.0.0.1:${port}`, token, close: closeServer(server) }
  }
```

(`serve()` is still un-awaited here; Task 5 fixes that.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tejika/server exec vitest run test/server.test.ts`
Expected: PASS — foreign-Host test green; the existing loopback `/api` tests still pass (they send a good Host).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/test/server.test.ts
git commit -m "fix(server): gate token-bearing SPA index by Host in loopback (H1)"
```

---

### Task 3: H2 — throw when network mode has no usable auth; drop dead token mode

**Files:**
- Modify: `packages/server/src/server.ts:9` (`AuthConfig` type) and `:67-79` (network branch)
- Test: `packages/server/test/server.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AuthConfig = { mode: 'custom'; verify: (req: Request) => boolean }` (the `{ mode: 'token' }` variant is removed — it was dead code in network mode). `createLocalServer` throws `Error` synchronously (rejects the returned promise) when `bind: 'network'` and `opts.auth` is not a usable custom verifier.

- [ ] **Step 1: Write the failing tests**

Add to `packages/server/test/server.test.ts` inside `describe('createLocalServer (network)')`:

```ts
  test('throws when network mode has no auth', async () => {
    await expect(createLocalServer({ app: 'tejika-test', bind: 'network' })).rejects.toThrow(
      /requires auth/,
    )
  })

  test('throws when network mode is given the removed token auth', async () => {
    await expect(
      // @ts-expect-error token mode is no longer a valid network AuthConfig
      createLocalServer({ app: 'tejika-test', bind: 'network', auth: { mode: 'token' } }),
    ).rejects.toThrow(/requires auth/)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tejika/server exec vitest run test/server.test.ts -t "network mode"`
Expected: FAIL — no throw today; both `createLocalServer` calls resolve.

- [ ] **Step 3: Narrow `AuthConfig` and throw on unusable network auth**

In `packages/server/src/server.ts`, change the type:

```ts
export type AuthConfig = { mode: 'custom'; verify: (req: Request) => boolean }
```

Then at the start of the network branch (right after the loopback `if` block returns), validate before building the gate:

```ts
  const allowedOrigin = opts.allowedOrigin ?? '*'
  const { auth } = opts
  if (auth?.mode !== 'custom' || typeof auth.verify !== 'function') {
    throw new Error(
      "createLocalServer: bind:'network' requires auth:{mode:'custom', verify}. " +
        'Network mode has no built-in authentication.',
    )
  }
```

Leave the rest of the network branch as-is for now (the gate can keep referencing `auth.verify`); Tasks 4 fixes CORS. Because `auth` is now proven `custom`, simplify the gate's condition in place — replace `if (auth?.mode === 'custom' && !auth.verify(ctx.req.raw))` with `if (!auth.verify(ctx.req.raw))`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tejika/server exec vitest run test/server.test.ts`
Expected: PASS — both new throw tests green; the existing custom-auth network test still passes.

- [ ] **Step 5: Verify types compile**

Run: `pnpm --filter @tejika/server run test:types`
Expected: PASS — the `@ts-expect-error` line is satisfied (token mode is now a type error).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server.ts packages/server/test/server.test.ts
git commit -m "fix(server): require custom auth in network mode, drop dead token mode (H2)"
```

---

### Task 4: Network CORS via Hono `cors()` with working OPTIONS preflight

**Files:**
- Modify: `packages/server/src/server.ts` (network branch, imports)
- Test: `packages/server/test/server.test.ts`

**Interfaces:**
- Consumes: `auth` proven `custom` (Task 3).
- Produces: network branch mounts `cors({ origin: allowedOrigin })` on `/api` and `/api/*` before the auth gate, so `OPTIONS` preflight returns 2xx with `Access-Control-Allow-Origin/-Headers/-Methods` and `Vary: Origin` without hitting the auth verifier; non-OPTIONS requests still pass through the auth gate.

- [ ] **Step 1: Write the failing test**

Add to `describe('createLocalServer (network)')`:

```ts
  test('answers OPTIONS preflight without requiring auth', async () => {
    const server = await createLocalServer({
      app: 'tejika-test',
      bind: 'network',
      allowedOrigin: 'https://example.com',
      auth: { mode: 'custom', verify: (req) => req.headers.get('x-key') === 'let-me-in' },
    })
    close = server.close

    const preflight = await server.app.request('/api', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-key',
      },
    })
    expect(preflight.status).toBeLessThan(300) // 204/200, not 403
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://example.com')
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-key')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tejika/server exec vitest run test/server.test.ts -t "preflight"`
Expected: FAIL — OPTIONS hits the auth gate → 403, and allow-methods/headers are absent.

- [ ] **Step 3: Swap hand-rolled CORS for `cors()`**

Add the import at the top of `server.ts`:

```ts
import { cors } from 'hono/cors'
```

Replace the network gate + mounts (the block from `const gate = async …` through the two `app.use('/api'...)` lines) with:

```ts
  const authGate = async (ctx: Context, next: Next): Promise<Response | undefined> => {
    if (!auth.verify(ctx.req.raw)) {
      return ctx.text('Forbidden', 403)
    }
    await next()
  }
  const corsMiddleware = cors({ origin: allowedOrigin })
  app.use('/api', corsMiddleware)
  app.use('/api/*', corsMiddleware)
  app.use('/api', authGate)
  app.use('/api/*', authGate)
```

`cors()` short-circuits `OPTIONS` with a 204 before `authGate` runs, and sets `Vary: Origin` + allow-headers/methods. Remove the old manual `ctx.header('Access-Control-Allow-Origin', allowedOrigin)` line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tejika/server exec vitest run test/server.test.ts`
Expected: PASS — preflight test green; the existing network custom-auth test still gets `access-control-allow-origin: https://example.com` on its GET and still 403s a bad key.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/test/server.test.ts
git commit -m "fix(server): use hono cors() for network mode, fix OPTIONS preflight"
```

---

### Task 5: Await `serve()` listening so bind errors reject instead of crashing

**Files:**
- Modify: `packages/server/src/server.ts` (both branches use a shared `listen` helper)
- Test: `packages/server/test/server.test.ts`

**Interfaces:**
- Consumes: `serve`, `ServerType` from `@hono/node-server`.
- Produces: `listen(app: Hono, port: number, hostname: string): Promise<ServerType>` — resolves once the server emits `'listening'` (via the `serve` ready callback), rejects on `once('error')` (e.g. `EADDRINUSE`). Both branches `await listen(...)` instead of calling `serve()` unawaited.

- [ ] **Step 1: Write the failing test**

Add a new top-level `describe` to `server.test.ts`:

```ts
describe('createLocalServer (lifecycle)', () => {
  test('rejects on EADDRINUSE instead of crashing later', async () => {
    const first = await createLocalServer({ app: 'tejika-test' })
    const port = Number(new URL(first.url).port)
    try {
      await expect(createLocalServer({ app: 'tejika-test', port })).rejects.toMatchObject({
        code: 'EADDRINUSE',
      })
    } finally {
      await first.close()
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tejika/server exec vitest run test/server.test.ts -t "EADDRINUSE"`
Expected: FAIL — the second `createLocalServer` resolves; the `'error'` event fires unhandled afterward (may surface as an unhandled-rejection/crash rather than a rejected promise).

- [ ] **Step 3: Add the `listen` helper and use it in both branches**

In `packages/server/src/server.ts`, add below `closeServer`:

```ts
function listen(app: Hono, port: number, hostname: string): Promise<ServerType> {
  return new Promise<ServerType>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, () => {
      server.off('error', reject)
      resolve(server)
    })
    server.once('error', reject)
  })
}
```

Loopback branch — replace `const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })` with:

```ts
    const server = await listen(app, port, '127.0.0.1')
```

Network branch — replace `const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' })` with:

```ts
  const server = await listen(app, port, '0.0.0.0')
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tejika/server exec vitest run test/server.test.ts`
Expected: PASS — the second bind rejects with `code: 'EADDRINUSE'`; no unhandled error; all prior tests still green.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/test/server.test.ts
git commit -m "fix(server): await serve() listening, reject on bind error"
```

---

### Task 6: Low-severity polish + auth test backfill + real socket fetch

**Files:**
- Modify: `packages/server/src/server.ts` (network `url`)
- Modify: `packages/server/src/auth.ts` (clarifying comments only)
- Test: `packages/server/test/auth.test.ts`, `packages/server/test/server.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: network `LocalServer.url` reports a locally reachable `http://127.0.0.1:${port}` (0.0.0.0 is a bind address, not connectable). Comments document the case-sensitive Host match and the `[::1]` origin alias. New auth-header edge tests + one real bound-socket fetch.

- [ ] **Step 1: Write the failing/behavioral tests**

Add to `packages/server/test/auth.test.ts` (inside its existing `describe`, matching the current import of `verifyLoopbackRequest` / `buildAllowedHosts`):

```ts
  test('allows a request with no Origin header (non-browser client)', () => {
    const ctx = {
      allowedHosts: buildAllowedHosts(4321),
      allowedOrigins: new Set(['http://127.0.0.1:4321']),
      token: 'tok',
    }
    const req = new Request('http://127.0.0.1:4321/api', {
      headers: { host: '127.0.0.1:4321', authorization: 'Bearer tok' },
    })
    expect(verifyLoopbackRequest(req, ctx)).toBe(true)
  })

  test('rejects a lowercase "bearer" scheme', () => {
    const ctx = {
      allowedHosts: buildAllowedHosts(4321),
      allowedOrigins: new Set(['http://127.0.0.1:4321']),
      token: 'tok',
    }
    const req = new Request('http://127.0.0.1:4321/api', {
      headers: { host: '127.0.0.1:4321', authorization: 'bearer tok' },
    })
    expect(verifyLoopbackRequest(req, ctx)).toBe(false)
  })

  test('rejects a missing Authorization header', () => {
    const ctx = {
      allowedHosts: buildAllowedHosts(4321),
      allowedOrigins: new Set(['http://127.0.0.1:4321']),
      token: 'tok',
    }
    const req = new Request('http://127.0.0.1:4321/api', { headers: { host: '127.0.0.1:4321' } })
    expect(verifyLoopbackRequest(req, ctx)).toBe(false)
  })

  test('rejects a present but non-allowlisted Origin', () => {
    const ctx = {
      allowedHosts: buildAllowedHosts(4321),
      allowedOrigins: new Set(['http://127.0.0.1:4321']),
      token: 'tok',
    }
    const req = new Request('http://127.0.0.1:4321/api', {
      headers: { host: '127.0.0.1:4321', origin: 'http://evil.example', authorization: 'Bearer tok' },
    })
    expect(verifyLoopbackRequest(req, ctx)).toBe(false)
  })
```

Add a real-socket test to `server.test.ts` inside `describe('createLocalServer (loopback)')`:

```ts
  test('serves over the real bound socket with a good Host + token', async () => {
    const server = await createLocalServer({ app: 'tejika-test' })
    close = server.close
    server.app.get('/api/ping', (ctx) => ctx.text('pong'))
    const res = await fetch(`${server.url}/api/ping`, {
      headers: { authorization: `Bearer ${server.token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('pong')
  })
```

- [ ] **Step 2: Run the tests to verify status**

Run: `pnpm --filter @tejika/server exec vitest run`
Expected: the four auth edge tests PASS immediately (they document existing correct behavior); the real-socket test PASSES (loopback fetch with default Host = `127.0.0.1:PORT` is allowlisted). If the real-socket test fails, stop — it means the bound-socket path regressed and must be fixed before polish.

- [ ] **Step 3: Report a reachable network URL + add clarifying comments**

In `packages/server/src/server.ts`, network branch, change the returned `url` from `http://0.0.0.0:${port}` to a locally reachable address:

```ts
  // 0.0.0.0 is a bind wildcard, not a connectable address; report loopback, which
  // is always reachable from this host. LAN peers use their own route to this host.
  return { app, url: `http://127.0.0.1:${port}`, close: closeServer(server) }
```

Update the existing network test's URL assertion in `server.test.ts` from `/^http:\/\/0\.0\.0\.0:\d+$/` to `/^http:\/\/127\.0\.0\.1:\d+$/`.

In `packages/server/src/auth.ts`, add a one-line comment above the Host check in `verifyLoopbackRequest` (do not change logic):

```ts
  // Host match is exact and case-sensitive by design: an unexpected-case Host is
  // treated as foreign (fail-closed), which is safe for the fixed loopback aliases.
  const host = request.headers.get('host')
```

In `packages/server/src/server.ts`, document the gate requirement on `attachEnkakuTransport`. Append to its existing JSDoc block (the `/** … */` above the function):

```ts
 * In loopback mode, pass a `path` under `/api` so the mounted transport inherits
 * the Host/Origin/token gate; a path outside `/api` is served unauthenticated.
```

- [ ] **Step 4: Run the full package test + lint**

Run: `pnpm --filter @tejika/server test`
Expected: PASS (types + unit).
Run: `rtk lint biome packages/server`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/auth.ts packages/server/test/auth.test.ts packages/server/test/server.test.ts
git commit -m "fix(server): reachable network url, auth edge tests, real-socket test"
```

---

## Final Verification

- [ ] **Run the whole package suite + lint:**

```bash
pnpm --filter @tejika/server test && rtk lint biome packages/server
```

Expected: all tests green, no lint errors.

- [ ] **Acceptance walk-through** — confirm each holds:
  - `/` and the SPA fallback return 403 for a non-allowlisted Host in loopback (Task 2).
  - `bind:'network'` with `{mode:'token'}` or no auth throws at creation (Task 3).
  - OPTIONS preflight succeeds in network mode with custom auth (Task 4).
  - `createLocalServer` rejects with `EADDRINUSE` instead of crashing (Task 5).
  - Unknown `/api/*` returns 404, not the SPA index (Task 1).
  - `static.ts` traversal is blocked by `serveStatic` (built-in `..` guard) and `injectToken` escaping is covered (Task 1).

## Self-Review Notes

- **Spec coverage:** H1 → Task 2; H2 → Task 3; CORS → Task 4; `serve()` await → Task 5; absolute static root → Task 1; scoped `/api` 404 → Task 1; `attachEnkakuTransport` doc note → **see below**; injectToken `$&` → Task 1; `[::1]` comment → kept + commented (Task 2 loopback comment); case-sensitive Host comment → Task 6; network reachable url → Task 6; test backfill → Tasks 1 & 6.
- **`attachEnkakuTransport` JSDoc note** is a one-line doc-only change in Task 6, Step 3; it carries no test (doc-only, per spec: document, not enforce).
- **get-port→serve TOCTOU** (low) is intentionally not separately fixed; Task 5's error handling covers the observable failure. Noted, not silently dropped.
