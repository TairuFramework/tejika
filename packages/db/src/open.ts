import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { HozonDB, type HozonDBParams, type StoreDefinition } from '@hozon/db'
import { NodeSQLiteAdapter, type SQLitePragmas } from '@hozon/node-sqlite'
import { getDatabasePath } from '@tejika/env'

export type OpenLocalDatabaseParams = {
  app: string
  name?: string
  path?: string
  stores: Array<StoreDefinition<unknown, unknown>>
  tablePrefix?: string
  logger?: HozonDBParams['logger']
  pragmas?: SQLitePragmas
}

/**
 * Open a local SQLite database for an app, register the given stores and run
 * their migrations eagerly so version and migration errors surface at open.
 * On failure the handle is closed before the original error is rethrown.
 */
export async function openLocalDatabase(params: OpenLocalDatabaseParams): Promise<HozonDB> {
  const path = params.path ?? getDatabasePath(params.app, params.name)
  if (path !== ':memory:') {
    await mkdir(dirname(path), { recursive: true })
  }

  const adapter = new NodeSQLiteAdapter({ database: path, pragmas: params.pragmas })
  let db: HozonDB | undefined
  try {
    const dbParams: HozonDBParams = { adapter }
    if (params.logger != null) {
      dbParams.logger = params.logger
    }
    if (params.tablePrefix != null) {
      dbParams.tablePrefix = params.tablePrefix
    }
    db = new HozonDB(dbParams)
    for (const store of params.stores) {
      db.register(store)
    }
    await db.migrate()
    return db
  } catch (error) {
    try {
      await (db ?? adapter).close()
    } catch {
      // Swallow close failures: the original error is what the caller needs.
    }
    throw error
  }
}
