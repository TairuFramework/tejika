import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { followLog } from '../src/follow.js'

describe('followLog', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tejika-follow-'))
    path = join(dir, 'daemon.log')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('streams appended data and stops on abort', async () => {
    writeFileSync(path, 'old\n')
    const controller = new AbortController()
    let received = ''
    const done = followLog(path, {
      signal: controller.signal,
      start: statSync(path).size,
      pollIntervalMs: 20,
      onData: (chunk) => {
        received += chunk.toString()
      },
    })
    appendFileSync(path, 'one\n')
    await vi.waitFor(() => expect(received).toBe('one\n'))
    appendFileSync(path, 'two\n')
    await vi.waitFor(() => expect(received).toBe('one\ntwo\n'))
    controller.abort()
    await done
  })

  test('starts from an explicit offset', async () => {
    writeFileSync(path, 'old\n')
    const controller = new AbortController()
    let received = ''
    const done = followLog(path, {
      signal: controller.signal,
      start: 0,
      pollIntervalMs: 20,
      onData: (chunk) => {
        received += chunk.toString()
      },
    })
    await vi.waitFor(() => expect(received).toBe('old\n'))
    controller.abort()
    await done
  })

  test('re-reads from the start after truncation', async () => {
    writeFileSync(path, 'a long first line\n')
    const controller = new AbortController()
    let received = ''
    const done = followLog(path, {
      signal: controller.signal,
      start: statSync(path).size,
      pollIntervalMs: 20,
      onData: (chunk) => {
        received += chunk.toString()
      },
    })
    writeFileSync(path, 'new\n')
    await vi.waitFor(() => expect(received).toBe('new\n'))
    controller.abort()
    await done
  })

  test('rejects when the file does not exist', async () => {
    await expect(
      followLog(join(dir, 'missing.log'), { signal: AbortSignal.abort() }),
    ).rejects.toThrow('ENOENT')
  })

  test('resolves immediately for an already-aborted signal', async () => {
    writeFileSync(path, 'x\n')
    await followLog(path, { signal: AbortSignal.abort() })
  })
})
