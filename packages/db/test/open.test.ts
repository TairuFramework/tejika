import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type HozonDB, InvalidTablePrefixError, SchemaVersionError } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { type OpenLocalDatabaseParams, openLocalDatabase } from '../src/index.js'

type Store = OpenLocalDatabaseParams['stores'][number]

function notes(migrations: Array<string>): Store {
  return {
    name: 'notes',
    migrations: Object.fromEntries(
      migrations.map((id) => [
        id,
        {
          up: async (db) => {
            await db.schema
              .createTable(`notes_${id}`)
              .ifNotExists()
              .addColumn('id', 'integer')
              .execute()
          },
        },
      ]),
    ),
    createAPI: () => ({}),
  }
}

async function listTables(file: string): Promise<Array<string>> {
  const adapter = new NodeSQLiteAdapter({ database: file })
  try {
    const rows = adapter.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
    return rows.map((row) => row.name)
  } finally {
    await adapter.close()
  }
}

describe('openLocalDatabase', () => {
  let dataDir: string
  const opened: Array<HozonDB> = []
  const open = async (...args: Parameters<typeof openLocalDatabase>) => {
    const db = await openLocalDatabase(...args)
    opened.push(db)
    return db
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tejika-db-'))
    process.env.TEJIKA_TEST_DATA_DIR = dataDir
  })

  afterEach(async () => {
    for (const db of opened.splice(0)) {
      await db.close()
    }
    delete process.env.TEJIKA_TEST_DATA_DIR
    delete process.env.TEJIKA_TEST_DATABASE_PATH
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('opens <name>.db under the data dir and migrates eagerly', async () => {
    const db = await open({ app: 'tejika-test', name: 'flow', stores: [notes(['001'])] })
    const file = join(dataDir, 'flow.db')
    expect(existsSync(file)).toBe(true)
    await db.close()
    const tables = await listTables(file)
    expect(tables).toContain('notes_001')
    expect(tables).toContain('hozon_notes_migration')
  })

  test('creates missing parent directories for an explicit path', async () => {
    const file = join(dataDir, 'a', 'b', 'x.db')
    await open({ app: 'tejika-test', path: file, stores: [notes(['001'])] })
    expect(existsSync(file)).toBe(true)
  })

  test('explicit path wins over <APP>_DATABASE_PATH', async () => {
    const envFile = join(dataDir, 'env.db')
    const explicit = join(dataDir, 'explicit.db')
    process.env.TEJIKA_TEST_DATABASE_PATH = envFile
    await open({ app: 'tejika-test', path: explicit, stores: [notes(['001'])] })
    expect(existsSync(explicit)).toBe(true)
    expect(existsSync(envFile)).toBe(false)
  })

  test('opens :memory: without touching the filesystem', async () => {
    await open({ app: 'tejika-test', path: ':memory:', stores: [notes(['001'])] })
    expect(readdirSync(dataDir)).toEqual([])
    expect(existsSync(join(process.cwd(), ':memory:'))).toBe(false)
  })

  test('applies tablePrefix', async () => {
    const file = join(dataDir, 'prefix.db')
    const db = await open({
      app: 'tejika-test',
      path: file,
      tablePrefix: 'tj',
      stores: [notes(['001'])],
    })
    await db.close()
    const tables = await listTables(file)
    expect(tables).toContain('tj_notes_migration')
    expect(tables).not.toContain('hozon_notes_migration')
  })

  test('rejects and releases the file after a failed migration', async () => {
    const file = join(dataDir, 'fail.db')
    const failing: Store = {
      name: 'notes',
      migrations: {
        '001': {
          up: async () => {
            throw new Error('boom')
          },
        },
      },
      createAPI: () => ({}),
    }
    // rmSync alone cannot prove release on POSIX, so also assert the adapter closes.
    const close = vi.spyOn(NodeSQLiteAdapter.prototype, 'close')
    try {
      await expect(
        openLocalDatabase({ app: 'tejika-test', path: file, stores: [failing] }),
      ).rejects.toThrow('boom')
      expect(close).toHaveBeenCalled()
    } finally {
      close.mockRestore()
    }
    rmSync(file)
    await open({ app: 'tejika-test', path: file, stores: [notes(['001'])] })
  })

  test('closes the adapter when HozonDB construction fails', async () => {
    const file = join(dataDir, 'prefix-fail.db')
    const close = vi.spyOn(NodeSQLiteAdapter.prototype, 'close')
    try {
      await expect(
        openLocalDatabase({
          app: 'tejika-test',
          path: file,
          tablePrefix: 'Bad-Prefix',
          stores: [notes(['001'])],
        }),
      ).rejects.toThrow(InvalidTablePrefixError)
      expect(close).toHaveBeenCalled()
    } finally {
      close.mockRestore()
    }
    rmSync(file)
    await open({ app: 'tejika-test', path: file, stores: [notes(['001'])] })
  })

  test('surfaces SchemaVersionError at open', async () => {
    const file = join(dataDir, 'version.db')
    const first = await open({ app: 'tejika-test', path: file, stores: [notes(['001', '002'])] })
    await first.close()
    await expect(
      openLocalDatabase({ app: 'tejika-test', path: file, stores: [notes(['001'])] }),
    ).rejects.toThrow(SchemaVersionError)
  })
})
