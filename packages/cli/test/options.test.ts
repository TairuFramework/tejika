import { Command } from 'commander'
import { describe, expect, test } from 'vitest'
import { withLogLevel } from '../src/options.js'

describe('withLogLevel', () => {
  test('registers a --log-level option with a default', () => {
    const cmd = withLogLevel(new Command())
    const opt = cmd.options.find((o) => o.long === '--log-level')
    expect(opt).toBeDefined()
    expect(opt?.defaultValue).toBe('warning')
  })
})
