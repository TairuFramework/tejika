import { afterEach, describe, expect, test } from 'vitest'
import { getPort, parsePort, resolvePort } from '../src/ports.js'

afterEach(() => {
  delete process.env.MYAPP_PORT
})

describe('parsePort', () => {
  test('accepts valid ports', () => {
    expect(parsePort('1')).toBe(1)
    expect(parsePort('8080')).toBe(8080)
    expect(parsePort('65535')).toBe(65535)
  })
  test('accepts a padded value', () => {
    expect(parsePort(' 8080 ')).toBe(8080)
  })
  test.each([
    '80abc',
    '80.5',
    '0x50',
    '-1',
    '',
    '   ',
    'abc',
  ])('rejects the malformed value %j', (value) => {
    expect(() => parsePort(value)).toThrow(/not a valid port number|Invalid port number/)
  })
  test.each(['0', '70000', '65536'])('rejects the out-of-range value %j', (value) => {
    expect(() => parsePort(value)).toThrow(/Invalid port number/)
  })
  test('names the source in the message when a label is given', () => {
    expect(() => parsePort('0', 'MYAPP_PORT')).toThrow('MYAPP_PORT is not a valid port number: "0"')
  })
})

describe('getPort', () => {
  test('returns the env override when set', async () => {
    process.env.MYAPP_PORT = '7777'
    await expect(getPort('myapp')).resolves.toBe(7777)
  })
  test('falls back to an available port', async () => {
    const port = await getPort('myapp', { default: 4000 })
    expect(port).toBeGreaterThan(0)
  })
  test('falls back to an available port when override is empty', async () => {
    process.env.MYAPP_PORT = ''
    const port = await getPort('myapp', { default: 4000 })
    expect(port).toBeGreaterThan(0)
  })
  test('returns the default verbatim when it is free', async () => {
    const { createServer } = await import('node:net')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const freePort = typeof address === 'object' && address != null ? address.port : 0
    await new Promise((resolve) => server.close(resolve))
    await expect(getPort('myapp', { default: freePort })).resolves.toBe(freePort)
  })
  test('forwards `host` to the underlying probe', async () => {
    const { createServer } = await import('node:net')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const freePort = typeof address === 'object' && address != null ? address.port : 0
    await new Promise((resolve) => server.close(resolve))
    await expect(getPort('myapp', { default: freePort, host: '127.0.0.1' })).resolves.toBe(freePort)
  })
  test.each([
    'abc',
    '80abc',
    '80.5',
    '0x50',
    '0',
    '-1',
    '70000',
  ])('throws on the invalid override %j', async (value) => {
    process.env.MYAPP_PORT = value
    await expect(getPort('myapp')).rejects.toThrow(/MYAPP_PORT is not a valid port number/)
  })
  test('throws on an invalid default', async () => {
    await expect(getPort('myapp', { default: 0 })).rejects.toThrow(/Invalid port number/)
  })
  test('throws on an invalid default even when a valid env override is set', async () => {
    process.env.MYAPP_PORT = '7777'
    await expect(getPort('myapp', { default: 70000 })).rejects.toThrow(/Invalid port number/)
  })
})

describe('resolvePort', () => {
  test('returns the default verbatim without probing', () => {
    expect(resolvePort('myapp', 4000)).toBe(4000)
  })
  test('returns the default even when the port is in use', async () => {
    const { createServer } = await import('node:net')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address != null ? address.port : 0
    try {
      expect(resolvePort('myapp', port)).toBe(port)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
  test('returns the env override when set', () => {
    process.env.MYAPP_PORT = '7777'
    expect(resolvePort('myapp', 4000)).toBe(7777)
  })
  test('throws on an invalid env override', () => {
    process.env.MYAPP_PORT = '0'
    expect(() => resolvePort('myapp', 4000)).toThrow(/MYAPP_PORT is not a valid port number/)
  })
  test('throws on an invalid default', () => {
    expect(() => resolvePort('myapp', 70000)).toThrow(/Invalid port number/)
  })
  test('throws on an invalid default even when a valid env override is set', () => {
    process.env.MYAPP_PORT = '7777'
    expect(() => resolvePort('myapp', 70000)).toThrow(/Invalid port number/)
  })
})
