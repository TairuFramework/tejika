import { afterEach, describe, expect, test } from 'vitest'
import { getDaemonStatus, stopDaemon } from '../src/status.js'

const APP = 'tejika-test'

afterEach(async () => {
  await stopDaemon({ app: APP }).catch(() => {})
})

describe('getDaemonStatus', () => {
  test('reports not-running when no pidfile exists', () => {
    const status = getDaemonStatus({ app: APP, pidPath: '/tmp/tejika-test-absent.pid' })
    expect(status.running).toBe(false)
    expect(status.stale).toBe(false)
  })
})
