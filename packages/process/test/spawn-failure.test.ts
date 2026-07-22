import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { DaemonBootError } from '../src/errors.js'
import { spawnDaemon } from '../src/spawn.js'

// `nano-spawn` rejects `nodeChildProcess` when the child cannot be spawned at all
// — it awaits the `spawn` event, which never arrives. That is not reachable for
// real here (nano-spawn rewrites the `node` command to `process.execPath`, which
// always exists), so the module is faked. It is the only way into the window this
// covers, and it lives in its own file because every other spawn test needs the
// real thing.
const spawnError = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })

vi.mock('nano-spawn', () => ({
  default: () => {
    const subprocess = Promise.reject(spawnError) as Promise<never> & {
      nodeChildProcess: Promise<never>
    }
    subprocess.nodeChildProcess = Promise.reject(spawnError)
    return subprocess
  },
}))

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tejika-spawn-fail-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// `spawnDaemon` awaited `subprocess.nodeChildProcess` to unref the child BEFORE
// anything had attached a handler to `exited` (the promise that turns a child
// death into a `DaemonBootError`). When that await rejected, the raw errno was
// thrown from there and `exited` was abandoned mid-rejection: an unhandled
// rejection, which Node treats as fatal — so a CLI that merely failed to spawn a
// daemon crashed instead of reporting a boot error. Vitest fails the run on an
// unhandled rejection, so this test also asserts that by simply passing.
test('a child that never spawns is a DaemonBootError, not an unhandled rejection', async () => {
  const error = await spawnDaemon({
    app: 'tejika-test',
    entry: join(dir, 'never-runs.ts'),
    socketPath: join(dir, 'app.sock'),
    pidPath: join(dir, 'app.pid'),
    logPath: join(dir, 'daemon.log'),
    timeoutMs: 2000,
  }).catch((err: unknown) => err)

  expect(error).toBeInstanceOf(DaemonBootError)
  expect((error as DaemonBootError).message).toContain('daemon failed to start')
  // The log path is the whole value of the wrapper: a raw ENOENT says nothing
  // about where to look.
  expect((error as DaemonBootError).logPath).toBe(join(dir, 'daemon.log'))
  expect((error as DaemonBootError).cause).toBe(spawnError)
})
