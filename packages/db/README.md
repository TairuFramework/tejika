# @tejika/db

Open local [hozon](https://github.com/TairuFramework/hozon) databases for CLI
tools and daemons. Node only: it uses `node:sqlite` through
`@hozon/node-sqlite`.

```sh
pnpm add @tejika/db
```

- `openLocalDatabase` — resolve an app's database file, create its parent
  directory, register the given stores and run their migrations eagerly, so
  version and migration errors surface at open. On failure the handle is closed
  and the original error is rethrown.

```ts
import { logStoreDefinition } from '@hozon/store-log'
import { openLocalDatabase } from '@tejika/db'

const db = await openLocalDatabase({ app: 'myapp', stores: [logStoreDefinition] })
await db.close()
```

The file is `getDatabasePath(app, name)` from `@tejika/env` unless `path` is given
(`':memory:'` is supported); `<APP>_DATABASE_PATH` overrides the default location.

Tables (store and migration) carry a prefix, `hozon` by default. Set `tablePrefix`
(`^[a-z][a-z0-9_]{0,30}$`) to change it, e.g. `tj` gives `tj_<store>_migration`. A store
can opt tables out with its `unprefixedTables` predicate.

Node only (`node:sqlite`): Electron main processes must mark `node:sqlite` external.
