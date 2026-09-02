import { describe, expect, test } from 'vitest'

import { appEnvVar } from '../src/env-var.js'

describe('appEnvVar', () => {
  test('uppercases the app slug and joins the key', () => {
    expect(appEnvVar('mokei', 'PORT')).toBe('MOKEI_PORT')
  })

  test('normalizes non-alphanumeric characters in the app slug to underscores', () => {
    expect(appEnvVar('my-app', 'SOCKET_PATH')).toBe('MY_APP_SOCKET_PATH')
  })

  test('prefixes an underscore when the slug starts with a digit', () => {
    // `1APP_DATA_DIR` is not a settable POSIX shell variable; `_1APP_DATA_DIR` is.
    expect(appEnvVar('1app', 'DATA_DIR')).toBe('_1APP_DATA_DIR')
  })
})
