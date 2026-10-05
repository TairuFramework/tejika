import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Command } from 'commander'
import stripAnsi from 'strip-ansi'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { addJSONOption, fail, parseJSONArg, printJSON, printNDJSON } from '../src/output.js'

const run = promisify(execFile)
const fixture = fileURLToPath(new URL('./fixtures/table.js', import.meta.url))

let stdout: Array<string>
let stderr: Array<string>
beforeEach(() => {
  stdout = []
  stderr = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('JSON output', () => {
  test('addJSONOption registers --json', () => {
    const cmd = addJSONOption(new Command('x')).parse(['--json'], { from: 'user' })
    expect(cmd.opts().json).toBe(true)
  })

  test('printJSON indents and printNDJSON writes one line', () => {
    printJSON({ a: 1 })
    printNDJSON({ a: [1, 2] })
    expect(stdout.join('')).toBe('{\n  "a": 1\n}\n{"a":[1,2]}\n')
  })
})

describe('parseJSONArg', () => {
  test('parses an inline value', async () => {
    expect(await parseJSONArg('--input', '{"a":1}')).toEqual({ a: 1 })
  })

  test('reads @path from a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tejika-cli-'))
    try {
      const path = join(dir, 'in.json')
      writeFileSync(path, '[1,2]')
      expect(await parseJSONArg('--input', `@${path}`)).toEqual([1, 2])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('names the flag on invalid JSON and on an unreadable file', async () => {
    await expect(parseJSONArg('--input', '{nope')).rejects.toThrow('Invalid JSON in --input value')
    await expect(parseJSONArg('--input', '@/definitely/missing.json')).rejects.toThrow(
      'Cannot read --input file /definitely/missing.json',
    )
  })
})

describe('fail', () => {
  test('writes the message to stderr and sets exit code 1', () => {
    fail(new Error('bad'))
    fail('worse')
    expect(stderr.join('')).toBe('✘ bad\n✘ worse\n')
    expect(process.exitCode).toBe(1)
  })
})

describe('renderTable', () => {
  test('renders a header and aligned rows', async () => {
    vi.restoreAllMocks()
    // Ink patches the console, which vitest's own console does not allow: run it in a process.
    const { stdout: out } = await run('node', [fixture])
    const text = stripAnsi(out)
    expect(text).toContain('ID      STATE')
    expect(text).toContain('a       running')
    expect(text).toContain('longer  done')
  }, 30_000)
})
