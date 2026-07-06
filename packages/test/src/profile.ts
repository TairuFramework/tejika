import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appEnvVar } from '@tejika/env'

export type TestProfileEnv = { dir: string; env: Record<string, string> }
export type TestProfile = TestProfileEnv & AsyncDisposable

export type TestProfileOptions = {
  /** Env keys pointed at the profile dir (via `appEnvVar`). Default `['DATA_DIR', 'STATE_DIR']`. */
  keys?: Array<string>
  /** Extra env entries; win over the key-derived ones. */
  extraEnv?: Record<string, string>
  /** Runs at dispose before the dir is removed — stop any daemon here. */
  onDispose?: (profile: TestProfileEnv) => Promise<void> | void
}

let counter = 0

/**
 * Allocate a throwaway app profile: a temp dir with `<APP>_<KEY>` env
 * overrides pointing at it, so everything a spawned CLI resolves through
 * `@tejika/env` lands in the dir. Use with `await using`, so at scope exit
 * `onDispose` runs (stop the daemon the profile spawned) and the dir is
 * removed. The pid + monotonic counter keep concurrent workers and repeated
 * profiles in one worker from colliding.
 */
export function createTestProfile(app: string, options: TestProfileOptions = {}): TestProfile {
  const { keys = ['DATA_DIR', 'STATE_DIR'], extraEnv, onDispose } = options
  const dir = join(tmpdir(), `${app}-it-${process.pid}-${counter++}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const env = { ...process.env } as Record<string, string>
  for (const key of keys) {
    env[appEnvVar(app, key)] = dir
  }
  Object.assign(env, extraEnv)
  return {
    dir,
    env,
    async [Symbol.asyncDispose]() {
      await onDispose?.({ dir, env })
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
