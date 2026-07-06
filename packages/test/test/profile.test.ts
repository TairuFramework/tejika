import { existsSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { createTestProfile } from '../src/profile.js'

describe('createTestProfile', () => {
  test('creates a temp dir and points the default env keys at it', async () => {
    await using profile = createTestProfile('my-app')
    expect(existsSync(profile.dir)).toBe(true)
    expect(profile.env.MY_APP_DATA_DIR).toBe(profile.dir)
    expect(profile.env.MY_APP_STATE_DIR).toBe(profile.dir)
  })

  test('supports custom keys and extraEnv, with extraEnv winning', async () => {
    await using profile = createTestProfile('my-app', {
      keys: ['DATA_DIR', 'SOCKET_PATH'],
      extraEnv: { MY_APP_SOCKET_PATH: '/custom/path.sock', OTHER: 'value' },
    })
    expect(profile.env.MY_APP_DATA_DIR).toBe(profile.dir)
    expect(profile.env.MY_APP_STATE_DIR).toBeUndefined()
    expect(profile.env.MY_APP_SOCKET_PATH).toBe('/custom/path.sock')
    expect(profile.env.OTHER).toBe('value')
  })

  test('two profiles in one worker get distinct dirs', async () => {
    await using first = createTestProfile('my-app')
    await using second = createTestProfile('my-app')
    expect(first.dir).not.toBe(second.dir)
  })

  test('dispose runs onDispose before removing the dir', async () => {
    let dirExistedInHook = false
    let hookDir = ''
    const profile = createTestProfile('my-app', {
      onDispose: ({ dir }) => {
        hookDir = dir
        dirExistedInHook = existsSync(dir)
      },
    })
    await profile[Symbol.asyncDispose]()
    expect(hookDir).toBe(profile.dir)
    expect(dirExistedInHook).toBe(true)
    expect(existsSync(profile.dir)).toBe(false)
  })
})
