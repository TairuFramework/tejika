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
})
