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
    expect(
      verifyLoopbackRequest(
        req({
          host: '127.0.0.1:8080',
          origin: 'http://127.0.0.1:8080',
          authorization: 'Bearer secret-token',
        }),
        ctx,
      ),
    ).toBe(true)
  })
  test('rejects a foreign Host (DNS rebinding)', () => {
    expect(
      verifyLoopbackRequest(
        req({
          host: 'evil.example.com',
          authorization: 'Bearer secret-token',
        }),
        ctx,
      ),
    ).toBe(false)
  })
  test('rejects a foreign Origin (CSRF)', () => {
    expect(
      verifyLoopbackRequest(
        req({
          host: '127.0.0.1:8080',
          origin: 'http://evil.example.com',
          authorization: 'Bearer secret-token',
        }),
        ctx,
      ),
    ).toBe(false)
  })
  test('rejects a wrong token', () => {
    expect(
      verifyLoopbackRequest(
        req({
          host: '127.0.0.1:8080',
          authorization: 'Bearer wrong',
        }),
        ctx,
      ),
    ).toBe(false)
  })

  test('allows a request with no Origin header (non-browser client)', () => {
    const ctx2 = {
      allowedHosts: buildAllowedHosts(4321),
      allowedOrigins: new Set(['http://127.0.0.1:4321']),
      token: 'tok',
    }
    const req2 = new Request('http://127.0.0.1:4321/api', {
      headers: { host: '127.0.0.1:4321', authorization: 'Bearer tok' },
    })
    expect(verifyLoopbackRequest(req2, ctx2)).toBe(true)
  })

  test('rejects a lowercase "bearer" scheme', () => {
    const ctx2 = {
      allowedHosts: buildAllowedHosts(4321),
      allowedOrigins: new Set(['http://127.0.0.1:4321']),
      token: 'tok',
    }
    const req2 = new Request('http://127.0.0.1:4321/api', {
      headers: { host: '127.0.0.1:4321', authorization: 'bearer tok' },
    })
    expect(verifyLoopbackRequest(req2, ctx2)).toBe(false)
  })

  test('rejects a missing Authorization header', () => {
    const ctx2 = {
      allowedHosts: buildAllowedHosts(4321),
      allowedOrigins: new Set(['http://127.0.0.1:4321']),
      token: 'tok',
    }
    const req2 = new Request('http://127.0.0.1:4321/api', { headers: { host: '127.0.0.1:4321' } })
    expect(verifyLoopbackRequest(req2, ctx2)).toBe(false)
  })

  test('rejects a present but non-allowlisted Origin', () => {
    const ctx2 = {
      allowedHosts: buildAllowedHosts(4321),
      allowedOrigins: new Set(['http://127.0.0.1:4321']),
      token: 'tok',
    }
    const req2 = new Request('http://127.0.0.1:4321/api', {
      headers: {
        host: '127.0.0.1:4321',
        origin: 'http://evil.example',
        authorization: 'Bearer tok',
      },
    })
    expect(verifyLoopbackRequest(req2, ctx2)).toBe(false)
  })
})
