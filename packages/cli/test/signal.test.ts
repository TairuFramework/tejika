import { describe, expect, test } from 'vitest'

import { withCommandSignal } from '../src/signal.js'

describe('withCommandSignal', () => {
  test('aborts the signal on SIGTERM and returns the work result', async () => {
    const result = await withCommandSignal(async (signal) => {
      expect(signal.aborted).toBe(false)
      process.emit('SIGTERM')
      expect(signal.aborted).toBe(true)
      return 'done'
    })
    expect(result).toBe('done')
  })

  test('aborts the signal on SIGINT', async () => {
    await withCommandSignal(async (signal) => {
      process.emit('SIGINT')
      expect(signal.aborted).toBe(true)
    })
  })

  test('removes its listeners once work settles, even on failure', async () => {
    const sigint = process.listenerCount('SIGINT')
    const sigterm = process.listenerCount('SIGTERM')
    await expect(
      withCommandSignal(async () => {
        expect(process.listenerCount('SIGINT')).toBe(sigint + 1)
        expect(process.listenerCount('SIGTERM')).toBe(sigterm + 1)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(process.listenerCount('SIGINT')).toBe(sigint)
    expect(process.listenerCount('SIGTERM')).toBe(sigterm)
  })
})
