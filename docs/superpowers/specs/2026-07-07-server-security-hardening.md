# Spec: Harden `@tejika/server` gate scope, network-mode auth, and lifecycle

**Origin:** repo audit 2026-07-02 (findings H1, H2 + all `@tejika/server`
mediums/lows). Promoted from `docs/agents/plans/next/2026-07-06-server-security-hardening.md`.

**Scope:** `packages/server/src/server.ts`, `packages/server/src/static.ts`,
`packages/server/test/`. No API rewrite — fix gate scope and network-mode
defaults, keep the loopback crypto mechanism (256-bit token, `timingSafeEqual`,
fail-closed Origin, exact-match Sets, `injectToken` escaping).

## Problem

The layered loopback defense is architecturally correct but has scope holes and
unsafe network-mode defaults:

- **H1 — token-bearing SPA index served ungated.** The Host/Origin/token gate is
  mounted only on `/api` and `/api/*`. `serveStaticSPA` serves `index.html` with
  the secret token injected at `/` and as the global `notFound` fallback, both
  ungated. A DNS-rebinding page can fetch `/` and read the token from
  `window.__APP_TOKEN__`, defeating the token layer.
- **H2 — network mode with `auth:{mode:'token'}` runs unauthenticated.** The
  network gate only checks `auth?.mode === 'custom'`. `bind:'network'` with
  `auth:{mode:'token'}` (or no auth) binds `0.0.0.0` with CORS `*` and **no
  auth** while the caller believes it is gated.

Plus network-mode CORS is broken for preflights, `serve()` errors crash instead
of rejecting, the static root couples to `process.cwd()`, and `notFound` hijacks
`/api` 404s.

## Requirements

### High severity

- **H1:** In loopback mode, apply the Host allowlist as global middleware
  (`app.use('*', hostGate)`) so `/` and the SPA fallback reject a non-allowlisted
  Host. Keep the full token/Origin gate on `/api`. The token-injected index must
  never reach a non-allowlisted Host.
- **H2:** Throw at `createLocalServer` creation time when `bind:'network'` has no
  usable auth — i.e. anything other than `auth:{mode:'custom', verify}`. Remove
  `{mode:'token'}` as an accepted network-mode auth (it is dead code there).

### Medium severity

- Replace hand-rolled network CORS with Hono's `cors()` middleware; bypass auth
  for `OPTIONS` preflight; emit `Access-Control-Allow-Headers`/`-Methods` and
  `Vary: Origin`.
- Await `serve()` `'listening'` and reject on `once('error')` so `EADDRINUSE`
  rejects `createLocalServer` instead of crashing the process later.
- `serveStaticSPA`: pass an **absolute** root to `serveStatic` (decouple from
  `process.cwd()` at request time; fix cross-drive Windows paths).
- `serveStaticSPA`: scope the SPA `notFound` fallback to non-`/api` paths so
  unknown `/api/*` returns 404, not the HTML index.
- `attachEnkakuTransport`: document that in loopback mode the path must be under
  `/api` to be gated (or enforce it). Minimal: JSDoc requirement note.

### Low severity

- `injectToken`: use a replacer function so a `$&`-style token cannot expand.
- Remove dead `[::1]` allowlist entries if only 127.0.0.1 is bound — OR keep and
  comment why. (Keep: browsers may send `[::1]` origin on loopback; add comment.)
- Add a comment that Host match is intentionally case-sensitive (fail-closed).
- Network-mode `url`: report a reachable address, not `http://0.0.0.0:PORT`.

## Acceptance

- `/` and the SPA fallback return 4xx for a non-allowlisted Host in loopback
  mode; token never reaches a foreign-Host response.
- `bind:'network'` with `auth:{mode:'token'}` (or no auth) throws at creation.
- OPTIONS preflight succeeds in network mode with custom auth configured.
- `createLocalServer` rejects (not crash-later) on `EADDRINUSE`.
- Unknown `/api/*` paths 404 instead of returning the SPA index.
- New tests green; `pnpm test` and `pnpm lint` green.

## Test backfill (part of acceptance)

- `static.ts` untested: add traversal test, `injectToken` escaping test, and the
  H1 foreign-Host rejection test.
- Auth tests: add `Origin: null` / lowercase `bearer` / missing-header cases.
- Add at least one real fetch to the bound socket (not only in-process
  `app.request()`).

## Non-goals

- No rewrite of the loopback crypto mechanism.
- Full network-mode token auth implementation (removed, not built).
- `attachEnkakuTransport` allowed-origin widening — tracked separately in
  `backlog/2026-06-24-widen-attach-enkaku-transport-allowed-origin.md`.
