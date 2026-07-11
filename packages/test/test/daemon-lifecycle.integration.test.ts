import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDaemonStatus, stopDaemon } from '@tejika/process'
import { expect, test } from 'vitest'
import { waitForDaemonRunning, waitForDaemonStopped } from '../src/daemon.js'
import { createTestProfile } from '../src/profile.js'

const APP = 'tejika-e2e'
const entry = fileURLToPath(new URL('./fixtures/daemon-entry.js', import.meta.url))

test('daemon lifecycle against an isolated profile', { timeout: 30_000 }, async () => {
  await using profile = createTestProfile(APP, {
    // Safety net if an assertion fails mid-test: stop whatever daemon the
    // profile spawned before the dir is removed.
    onDispose: async ({ dir }) => {
      const pidPath = join(dir, `${APP}.pid`)
      await stopDaemon({ app: APP, pidPath }).catch(() => {})
      await waitForDaemonStopped({ pidPath, timeoutMs: 3_000 })
    },
  })
  const pidPath = join(profile.dir, `${APP}.pid`)

  // The child resolves every path through the profile env, keeping the real
  // state/data dirs untouched.
  const child = spawn('node', [entry], { env: profile.env, stdio: 'ignore' })
  try {
    const pid = await waitForDaemonRunning({ pidPath, timeoutMs: 10_000 })
    expect(pid).toBe(child.pid)
    expect(existsSync(join(profile.dir, `${APP}.sock`))).toBe(true)

    await stopDaemon({ app: APP, pidPath })
    await waitForDaemonStopped({ pidPath })
    expect((await getDaemonStatus({ app: APP, pidPath })).state).not.toBe('running')
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL')
  }
})
