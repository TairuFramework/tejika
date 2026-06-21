import { afterEach, describe, expect, test } from 'vitest'
import { createLocalServer } from '../src/server.js'

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
})

describe('createLocalServer (network)', () => {
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
})
