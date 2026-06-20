import { afterEach, describe, expect, test } from 'vitest'
import { getPort } from '../src/ports.js'

afterEach(() => {
  delete process.env.MYAPP_PORT
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
})
