import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { getDaemonStatus, stopDaemon } from '@tejika/process'
import { expect, test } from 'vitest'

import { waitForDaemonStopped } from '../src/daemon.js'
import { poll } from '../src/poll.js'
import { createTestProfile } from '../src/profile.js'
import { runCLI } from '../src/run.js'

// Everything here races the public ensureDaemon() entry point across
// SEPARATE OS PROCESSES — the actual production shape (two CLI invocations
// racing a daemon boot) — rather than driving it twice from one process, as
// packages/process/test/controller.test.ts does. Follows
// daemon-lifecycle.integration.test.ts's shape: an isolated createTestProfile
// per test, real `spawn`/subprocess execution, and `await using` cleanup.

const ensureClientEntry = fileURLToPath(new URL('./fixtures/ensure-client.js', import.meta.url))
const ensureCrashEntry = fileURLToPath(new URL('./fixtures/ensure-crash.js', import.meta.url))
const persistentClientEntry = fileURLToPath(
  new URL('./fixtures/persistent-client.js', import.meta.url),
)

// The flagship scenario this branch exists for: two CLIs cold-start the same
// daemon at the same moment. `fixtures/ensure-client.js` calls ensureDaemon()
// with the socket/pid paths left to their DEFAULTS (resolved from the profile
// env, never passed explicitly) — the configuration the README documents, and
// the one where the "loser gets a spurious DaemonBootError even though a
// healthy daemon is up" Critical actually lived. `controller.test.ts`'s own
// "defaulted pidPath" test drives the same gap but from ONE process running
// ensureDaemon() twice; this drives it from two.
test('two separate processes cold-start the same daemon concurrently, both get a working client', {
  timeout: 60_000,
}, async () => {
  const App = 'tejika-e2e'
  await using profile = createTestProfile(App, {
    onDispose: async ({ dir }) => {
      const pidPath = join(dir, `${App}.pid`)
      await stopDaemon({ app: App, pidPath }).catch(() => {})
      await waitForDaemonStopped({ pidPath, timeoutMs: 3_000 })
    },
  })
  const pidPath = join(profile.dir, `${App}.pid`)

  const [a, b] = await Promise.all([
    runCLI([ensureClientEntry], { env: profile.env }),
    runCLI([ensureClientEntry], { env: profile.env }),
  ])

  for (const result of [a, b]) {
    expect(result.stdout).toContain('ENSURE_CLIENT_OK')
    expect(result.code).toBe(0)
  }

  // Exactly one daemon ends up running: the O_EXCL lock admits only one
  // winner, so a single lockfile naming a live, ready daemon is what "one
  // daemon" looks like from the outside.
  const status = await getDaemonStatus({ app: App, pidPath })
  expect(status.state).toBe('running')
})

// A daemon entry that crashes before binding its socket. ensureDaemon() must
// reject with a DaemonBootError (carrying a log path) FAST — not burn the
// whole timeoutMs budget — and, just as importantly, must not leave the
// calling process pinned alive by an abandoned socket-wait timer for the rest
// of that budget. Asserting only that the returned promise settles quickly
// misses that second half entirely: a previous test in this repo made exactly
// that mistake and passed for a whole 10s-budget hang. So this drives
// ensureDaemon() from a real child process (fixtures/ensure-crash.js, which
// deliberately calls no process.exit()) and measures how fast THAT PROCESS
// exits, with a generous 15s budget it must finish in a small fraction of.
test('a boot crash fails fast and does not pin the process alive', {
  timeout: 25_000,
}, async () => {
  const App = 'tejika-e2e-crash'
  await using profile = createTestProfile(App, {
    onDispose: async ({ dir }) => {
      const pidPath = join(dir, `${App}.pid`)
      await stopDaemon({ app: App, pidPath }).catch(() => {})
    },
  })

  const started = Date.now()
  const result = await runCLI([ensureCrashEntry], { env: profile.env })
  const elapsed = Date.now() - started

  expect(result.stdout).toContain('caught DaemonBootError')
  expect(result.stdout).toContain('logPath=')
  expect(result.stdout).not.toContain('logPath=none')
  expect(result.stdout).not.toContain('unexpectedly resolved')
  // Budget was 15s; a fast failure that does not pin the process exits in a
  // small fraction of it.
  expect(elapsed).toBeLessThan(5_000)
})

/** Poll until `predicate` matches a line already seen on `lines`. */
async function waitForLine(
  lines: Array<string>,
  predicate: (line: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const line = await poll(() => lines.find(predicate), { timeoutMs, intervalMs: 100 })
  if (line == null) {
    throw new Error(`no matching line within ${timeoutMs}ms (seen: ${JSON.stringify(lines)})`)
  }
  return line
}

// A real client process (fixtures/persistent-client.js) holds one ensureDaemon()
// connection for its whole lifetime. The daemon it is connected to gets
// SIGKILLed out from under it, then revived by a FRESH, separate process
// (fixtures/ensure-client.js, reused here as the revival probe). The original
// client's own auto-reconnect — not a new connection — must then serve its next
// request.
test('a client survives its daemon being SIGKILLed and revived by a fresh process', {
  timeout: 90_000,
}, async () => {
  const App = 'tejika-e2e'
  await using profile = createTestProfile(App, {
    onDispose: async ({ dir }) => {
      const pidPath = join(dir, `${App}.pid`)
      await stopDaemon({ app: App, pidPath }).catch(() => {})
    },
  })
  const pidPath = join(profile.dir, `${App}.pid`)

  const client = spawn('node', [persistentClientEntry], { env: profile.env })
  const lines: Array<string> = []
  createInterface({ input: client.stdout }).on('line', (line) => lines.push(line))

  try {
    await waitForLine(lines, (line) => line === 'READY', 20_000)

    client.stdin.write('ping\n')
    await waitForLine(lines, (line) => line.startsWith('PONG:'), 20_000)
    expect(lines.at(-1)).toBe('PONG:pong')

    const { pid } = JSON.parse(readFileSync(pidPath, 'utf8')) as { pid: number }
    process.kill(pid, 'SIGKILL')
    await waitForDaemonStopped({ pidPath, timeoutMs: 5_000 })

    // Revive from a FRESH process, not this test's own process and not the
    // persistent client itself.
    const revive = await runCLI([ensureClientEntry], { env: profile.env })
    expect(revive.stdout).toContain('ENSURE_CLIENT_OK')
    expect(revive.code).toBe(0)

    lines.length = 0
    client.stdin.write('ping\n')
    await waitForLine(lines, (line) => line.startsWith('PONG:'), 25_000)
    expect(lines.at(-1)).toBe('PONG:pong')
  } finally {
    if (client.exitCode == null) client.kill('SIGKILL')
  }
})
