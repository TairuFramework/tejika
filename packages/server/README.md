# @tejika/server

A local Hono HTTP server for CLI daemons, in loopback-private (default) or
network mode. Loopback mode binds `127.0.0.1`, mints a random bearer token, and
gates `/api` with Host/Origin/token defenses (DNS-rebinding + CSRF + bearer).
Network mode binds `0.0.0.0` with CORS and a custom auth hook.

```sh
pnpm add @tejika/server
```

- `createLocalServer` — start a server and get back its `app` (Hono), `url`,
  `close`, and (loopback only) `token`. Only routes mounted under `/api` inherit
  the auth gate.
- `attachEnkakuTransport` — attach an Enkaku server transport to the Hono app.
- `serveStaticSPA` — serve a single-page app from a directory, injecting the
  loopback token into its `index.html` (the routes themselves are covered by the
  global loopback Host check, not the `/api` bearer gate).
- `buildAllowedHosts` / `verifyLoopbackRequest` — the loopback host allowlist
  and request check, exposed for custom wiring.

```ts
import { createLocalServer } from '@tejika/server'

const server = await createLocalServer({ app: 'myapp' }) // loopback + token
server.app.get('/api/status', (c) => c.json({ ok: true }))
console.log(server.url, server.token)
await server.close()
```

Keep every state-changing endpoint under `/api`: a route mounted outside it
bypasses the gate, and in network mode is reachable unauthenticated by the whole
LAN.
