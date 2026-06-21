import { timingSafeEqual } from 'node:crypto'

export type GateContext = {
  allowedHosts: Set<string>
  allowedOrigins: Set<string>
  token: string
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  // Length check first: timingSafeEqual throws on unequal lengths.
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Host:port values accepted on the Host/Origin headers for a loopback bind.
 * Loopback and wildcard binds are both reachable via localhost, so the allowlist
 * covers every loopback alias the browser might send.
 */
export function buildAllowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
}

/**
 * Gate a loopback request. The Host-header allowlist defeats DNS rebinding; the
 * Origin check defeats classic CSRF when an Origin is present; the bearer token
 * defeats a blind cross-origin fetch that cannot read the token. A request with
 * no Origin header is treated as a non-browser client and allowed past the
 * Origin check (it must still pass the Host and token checks).
 */
export function verifyLoopbackRequest(request: Request, ctx: GateContext): boolean {
  const host = request.headers.get('host')
  if (host == null || !ctx.allowedHosts.has(host)) return false

  const origin = request.headers.get('origin')
  if (origin != null && !ctx.allowedOrigins.has(origin)) return false

  const auth = request.headers.get('authorization')
  const prefix = 'Bearer '
  if (auth == null || !auth.startsWith(prefix)) return false
  return safeEqual(auth.slice(prefix.length), ctx.token)
}
