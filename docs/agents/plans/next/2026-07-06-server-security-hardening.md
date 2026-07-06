# Harden `@tejika/server` gate scope, network-mode auth, and server lifecycle

**Priority:** next (step 1 of the 2026-07-02 audit's order of attack — security, small diffs)
**Origin:** repo audit 2026-07-02 (findings H1, H2 + all `@tejika/server` mediums/lows).
**Where:** `packages/server/src/server.ts`, `packages/server/src/static.ts`, `packages/server/test/`.

## High severity

### H1 — Token-bearing SPA index served with no Host gate (DNS rebinding)

`packages/server/src/server.ts:61-62` mounts the Host/Origin/token gate only on
`/api` and `/api/*`, but `serveStaticSPA` (`packages/server/src/static.ts:27-29`)
serves `index.html` **with the secret bearer token injected** at `/` and as the
global `notFound` fallback — completely ungated. A DNS-rebinding page (attacker
domain rebound to 127.0.0.1) can fetch `/` from the victim's browser and read the
token out of `window.__APP_TOKEN__`, defeating the token layer entirely.

**Fix:** apply the Host allowlist check as global middleware
(`app.use('*', hostGate)`) in loopback mode, keeping the token/Origin gate on
`/api`. The token-injected index must never be served to a non-allowlisted Host.

### H2 — Network mode with `auth: {mode:'token'}` silently runs unauthenticated

`packages/server/src/server.ts:71` only checks `auth?.mode === 'custom'`. A
caller writing `bind: 'network', auth: {mode: 'token'}` gets a server bound to
`0.0.0.0` with **no authentication** and CORS `*`, while believing it is
token-gated. The `{mode:'token'}` variant of `AuthConfig` is dead code in
network mode.

**Fix:** throw at creation time if `bind: 'network'` without a usable auth
config; either implement token mode for network or remove it from the accepted
type there.

## Medium severity

- `src/server.ts:69-75` — hand-rolled network-mode CORS is broken for
  non-simple requests: OPTIONS preflights hit the custom auth hook and get 403;
  no `Access-Control-Allow-Headers`/`-Methods`; no `Vary: Origin`. Use Hono's
  `cors()` middleware and bypass auth for OPTIONS.
- `src/server.ts:63,78` — `serve()` is never awaited for `'listening'` and has
  no `'error'` handler: `EADDRINUSE` becomes an unhandled `'error'` event that
  crashes the process after `createLocalServer` already "succeeded". Wrap in a
  promise resolving on the listening callback, rejecting on `once('error')`.
- `src/server.ts:87-94` — `attachEnkakuTransport` mounts at any caller-supplied
  path with no relationship to the `/api` gate; outside `/api` in loopback mode
  it is fully unauthenticated. Document the requirement or enforce the prefix.
  (Related backlog item: `2026-06-24-widen-attach-enkaku-transport-allowed-origin.md`.)
- `src/static.ts:28` — `serveStatic({ root: relative(process.cwd(), opts.dir) })`
  couples serving to `process.cwd()` at request time: a later `chdir` (common in
  daemons) silently breaks or re-points the static root; cross-drive paths break
  on Windows. Pass an absolute root.
- `src/static.ts:29` — `app.notFound(renderIndex)` hijacks 404s app-wide, so
  unknown `/api/*` paths return the HTML index instead of a 404. Scope the SPA
  fallback to non-`/api` paths.

## Low severity

- `injectToken` uses string `replace` (a `$&`-style token would expand — use a
  replacer function).
- Dead `[::1]` allowlist entries while binding 127.0.0.1 only.
- Host match is case-sensitive (fail-closed, fine — add a comment saying so).
- Network-mode `url` is `http://0.0.0.0:PORT` (not connectable); report a
  reachable address.
- get-port→serve TOCTOU (acceptable locally; pair with the `serve()` error
  handling above).

## Test backfill (part of acceptance)

- `static.ts` is entirely untested: add traversal test, `injectToken` escaping
  test, and a test that the token-bearing index rejects a foreign Host (the H1
  scenario).
- Auth tests missing `Origin: null` / lowercase `bearer` / missing-header cases.
- All server tests use in-process `app.request()`; add at least one real fetch
  to the bound socket.

## Acceptance

- `/` and the SPA fallback return 4xx for a non-allowlisted Host in loopback
  mode; token never reaches a foreign-Host response.
- `bind: 'network'` with `auth: {mode:'token'}` (or no auth) throws at creation.
- OPTIONS preflight succeeds in network mode with custom auth configured.
- `createLocalServer` rejects (not crash-later) on `EADDRINUSE`.
- Unknown `/api/*` paths 404 instead of returning the SPA index.
- New tests above green; `pnpm test` and `pnpm lint` green.

## Context kept from the audit

The layered loopback defense is the right architecture: 256-bit `randomBytes`
token compared via `timingSafeEqual`, fail-closed handling of missing/`null`
Origins, exact-match Sets, `injectToken` escaping against `</script>` breakout.
The flaws are in gate scope and network-mode defaults, not the crypto — don't
rewrite the mechanism, fix its scope.
