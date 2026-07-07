import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createLocalServer } from '../src/server.js'
import { serveStaticSPA } from '../src/static.js'

const fixtureDir = mkdtempSync(join(tmpdir(), 'tejika-server-'))
writeFileSync(join(fixtureDir, 'index.html'), '<head></head><body>app</body>')

let close: (() => Promise<void>) | undefined

afterEach(async () => {
  await close?.()
  close = undefined
})

describe('createLocalServer (loopback)', () => {
  test('issues a token and gates /api by Host + token', async () => {
    const server = await createLocalServer({ app: 'tejika-test' })
    close = server.close
    expect(server.token).toMatch(/^[0-9a-f]{64}$/)
    const port = new URL(server.url).port

    // A request with the correct loopback Host + bearer token passes the gate
    // (no handler is mounted at /api, so it falls through to 404 — not 401/403).
    const allowed = await server.app.request('/api', {
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${server.token}` },
    })
    expect(allowed.status).not.toBe(401)
    expect(allowed.status).not.toBe(403)

    // A foreign Host (DNS-rebinding attempt) is rejected.
    const foreign = await server.app.request('/api', {
      headers: { host: 'evil.example.com', authorization: `Bearer ${server.token}` },
    })
    expect(foreign.status).toBe(403)

    // A wrong token is rejected even with the correct Host.
    const wrongToken = await server.app.request('/api', {
      headers: { host: `127.0.0.1:${port}`, authorization: 'Bearer wrong' },
    })
    expect(wrongToken.status).toBe(403)
  })

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
})

describe('createLocalServer (network)', () => {
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

  test('binds without a token and gates /api via the custom auth hook', async () => {
    const server = await createLocalServer({
      app: 'tejika-test',
      bind: 'network',
      allowedOrigin: 'https://example.com',
      auth: { mode: 'custom', verify: (req) => req.headers.get('x-key') === 'let-me-in' },
    })
    close = server.close
    expect(server.token).toBeUndefined()
    expect(server.url).toMatch(/^http:\/\/0\.0\.0\.0:\d+$/)

    const allowed = await server.app.request('/api', { headers: { 'x-key': 'let-me-in' } })
    expect(allowed.status).not.toBe(403)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://example.com')

    const denied = await server.app.request('/api', { headers: { 'x-key': 'nope' } })
    expect(denied.status).toBe(403)
  })

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
})
