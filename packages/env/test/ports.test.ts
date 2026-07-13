import { afterEach, describe, expect, test } from 'vitest'
import { getPort, parsePort } from '../src/ports.js'

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
  test('throws on a non-numeric override', async () => {
    process.env.MYAPP_PORT = 'abc'
    await expect(getPort('myapp')).rejects.toThrow(/not a valid port/)
  })
})
