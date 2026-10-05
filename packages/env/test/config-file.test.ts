import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { expandHome, readJSONFile } from '../src/config-file.js'

describe('expandHome', () => {
  test('expands ~ and ~/ paths', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/a/b.json')).toBe(join(homedir(), 'a', 'b.json'))
  })

  test('leaves other paths untouched', () => {
    expect(expandHome('/abs/~/x')).toBe('/abs/~/x')
    expect(expandHome('rel/x')).toBe('rel/x')
    expect(expandHome('~user/x')).toBe('~user/x')
  })
})

describe('readJSONFile', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tejika-env-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('parses a JSON file', async () => {
    const path = join(dir, 'a.json')
    await writeFile(path, '{"a":1}')
    expect(await readJSONFile(path)).toEqual({ a: 1 })
  })

  test('returns the default on ENOENT, including a falsy one', async () => {
    expect(await readJSONFile(join(dir, 'missing.json'), { default: { x: 1 } })).toEqual({ x: 1 })
    expect(await readJSONFile(join(dir, 'missing.json'), { default: null })).toBeNull()
  })

  test('throws naming the path on ENOENT without a default', async () => {
    const path = join(dir, 'missing.json')
    await expect(readJSONFile(path)).rejects.toThrow(path)
  })

  test('throws naming the path on parse failure, even with a default', async () => {
    const path = join(dir, 'bad.json')
    await writeFile(path, '{nope')
    await expect(readJSONFile(path, { default: {} })).rejects.toThrow(path)
  })

  test('throws naming the path on other read failures', async () => {
    await expect(readJSONFile(dir, { default: {} })).rejects.toThrow(dir)
  })
})
