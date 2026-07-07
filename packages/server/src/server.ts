import { randomBytes } from 'node:crypto'
import { ServerTransport } from '@enkaku/http-serve'
import type { ProtocolDefinition } from '@enkaku/protocol'
import { type ServerType, serve } from '@hono/node-server'
import { getPort } from '@tejika/env'
import { type Context, Hono, type Next } from 'hono'
import { buildAllowedHosts, verifyLoopbackRequest } from './auth.js'

export type AuthConfig = { mode: 'token' } | { mode: 'custom'; verify: (req: Request) => boolean }

export type CreateLocalServerOptions = {
  app: string
  /** `loopback` (default): bind 127.0.0.1 with token gate. `network`: bind 0.0.0.0 with CORS + custom auth. */
  bind?: 'loopback' | 'network'
  port?: number
  /** CORS allowed origin for `network` mode. Default `*`. */
  allowedOrigin?: string
  auth?: AuthConfig
}

export type LocalServer = {
  app: Hono
  url: string
  /** Random bearer token, present only in loopback mode. */
  token?: string
  close: () => Promise<void>
}

function closeServer(server: ServerType): () => Promise<void> {
  return () => new Promise<void>((resolve) => server.close(() => resolve()))
}

/**
 * Create a local HTTP server. In `loopback` mode (default) it binds 127.0.0.1,
 * generates a random bearer token, and gates `/api` with the Host/Origin/token
 * defenses (DNS-rebinding + CSRF + bearer). In `network` mode it binds 0.0.0.0,
 * applies CORS from `allowedOrigin`, and gates `/api` with the custom auth hook.
 * The returned Hono `app` is exposed so callers can attach routes/transports.
 */
export async function createLocalServer(opts: CreateLocalServerOptions): Promise<LocalServer> {
  const bind = opts.bind ?? 'loopback'
  const port = opts.port ?? (await getPort(opts.app))
  const app = new Hono()

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

  const allowedOrigin = opts.allowedOrigin ?? '*'
  const { auth } = opts
  const gate = async (ctx: Context, next: Next): Promise<Response | undefined> => {
    ctx.header('Access-Control-Allow-Origin', allowedOrigin)
    if (auth?.mode === 'custom' && !auth.verify(ctx.req.raw)) {
      return ctx.text('Forbidden', 403)
    }
    await next()
  }
  app.use('/api', gate)
  app.use('/api/*', gate)
  const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' })
  return { app, url: `http://0.0.0.0:${port}`, close: closeServer(server) }
}

/**
 * Mount an Enkaku HTTP server transport at `opts.path` on the Hono app and
 * return it, so the caller can wire it to a daemon (e.g. pipe its stream to a
 * socket transport). The route forwards each request to the transport's bridge.
 */
export function attachEnkakuTransport<Protocol extends ProtocolDefinition>(
  app: Hono,
  opts: { path: string; allowedOrigin?: string },
): ServerTransport<Protocol> {
  const transport = new ServerTransport<Protocol>({ allowedOrigin: opts.allowedOrigin })
  app.all(opts.path, (ctx) => transport.fetch(ctx.req.raw))
  return transport
}
