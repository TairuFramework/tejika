# Harden `@tejika/server` gate scope, network-mode auth, and lifecycle

**Status:** complete
**Date:** 2026-07-07
**Origin:** repo audit 2026-07-02 (findings H1, H2 + all `@tejika/server` mediums/lows).
**Scope:** `packages/server/` (`src/server.ts`, `src/static.ts`, `src/auth.ts`, tests).

## Goal

Close the gate-scope and network-mode-auth holes the audit found, without
rewriting the loopback crypto mechanism — fix scope and defaults only.

## What was built

**High severity**
- **H1 — token-bearing SPA index no longer served ungated.** The loopback
  Host/Origin/token gate was mounted only on `/api`, but `serveStaticSPA` serves
  `index.html` with the secret token injected at `/` and as the SPA fallback. Added
  a global Host-allowlist middleware (`app.use('*', hostGate)`) registered before
  the `/api` gate, so `/`, static assets, and any SPA-fallback path reject a
  non-allowlisted Host (defeats DNS rebinding reading `window.__APP_TOKEN__`). The
  full token/Origin gate stays on `/api`.
- **H2 — network mode can no longer run unauthenticated.** `AuthConfig` was
  narrowed to only `{ mode: 'custom'; verify }` (the `{ mode: 'token' }` variant
  was dead code in network mode and is removed). `createLocalServer` now throws
  before binding when `bind: 'network'` lacks a usable custom verifier — previously
  `bind:'network', auth:{mode:'token'}` bound `0.0.0.0` with CORS `*` and no auth.

**Medium / low**
- Network CORS now uses Hono's `cors()` middleware, mounted before the auth gate:
  OPTIONS preflight succeeds (2xx) without hitting the verifier, and carries
  `Access-Control-Allow-Headers`/`-Methods` + `Vary: Origin`. The old hand-rolled
  unconditional `Access-Control-Allow-Origin` was removed so `cors()` is the single
  header owner.
- `serve()` is awaited via a `listen()` helper that resolves on the ready callback
  and rejects on `once('error')`, so `EADDRINUSE` rejects `createLocalServer`
  instead of crashing the process later. A persistent `'error'` handler is attached
  after listen so a late runtime error logs instead of crashing.
- `serveStaticSPA` uses an absolute `resolve()`d root (decoupled from request-time
  `process.cwd()`, so a daemon `chdir` cannot re-point serving). The SPA `notFound`
  fallback is scoped to non-API paths (`path === '/api' || path.startsWith('/api/')`)
  so unknown `/api/*` returns a real 404 while a client route like `/apiary` still
  gets the SPA index.
- `injectToken` uses a function replacer for the `</head>` splice so a `$&`-style
  token cannot expand, while keeping the `<`/`>` unicode-escaping against
  `</script>` breakout.
- Network `url` reports the reachable `http://127.0.0.1:${port}` rather than the
  unconnectable `http://0.0.0.0:${port}`.
- `createLocalServer` and `attachEnkakuTransport` JSDoc now warn that routes
  mounted outside `/api` bypass the gate — and in network mode are reachable
  unauthenticated by the whole LAN. This is documented, not enforced.

## Key design decisions

- **Fix scope, not mechanism.** The layered loopback defense (256-bit `randomBytes`
  token compared with `timingSafeEqual`, fail-closed missing/`null` Origin,
  exact-match Sets, `injectToken` escaping) was sound; the flaws were gate scope and
  network defaults. The crypto path is untouched.
- **Host match is intentionally case-sensitive** (fail-closed): an unexpected-case
  Host is treated as foreign. Both the global `hostGate` and `verifyLoopbackRequest`
  use the same lowercase `buildAllowedHosts` set, so they are consistent.
- **Network token auth was removed, not implemented** — no built-in network auth;
  callers must supply a custom verifier or the server refuses to start.
- **`/api` is the trust boundary.** Only routes under `/api` inherit the gate;
  callers must keep state-changing endpoints there.

## Tests

- `static.ts` gained a full test file: `injectToken` `<`/`>` and `$&` escaping,
  absolute-root serving after a `chdir`, `/api` 404 vs SPA-fallback boundary
  (`/apiary` → SPA, bare `/api` → 404).
- Server tests: H1 foreign-Host rejection at `/` and a deep SPA-fallback path; H2
  throw cases; OPTIONS preflight; `EADDRINUSE` rejection; a real bound-socket
  `fetch` (not only in-process `app.request`).
- Auth tests: no-Origin allowed, lowercase `bearer` rejected, missing Authorization
  rejected, non-allowlisted Origin rejected.
- Final state: 25/25 in `@tejika/server`, types clean, native `biome check` clean.
  Verified by a per-task review loop plus a whole-branch security review
  (verdict: ready to merge, no Critical/Important).

## Related / follow-on

- Consumer-driven `attachEnkakuTransport` allowed-origin widening remains tracked in
  `backlog/2026-06-24-widen-attach-enkaku-transport-allowed-origin.md`.
- Remaining env-path hardening is `backlog/2026-07-06-env-paths-hardening.md`.
- This was step 1 of the 2026-07-02 audit order of attack (see `roadmap.md`);
  next up is `next/2026-07-06-publishing-readiness.md`.
