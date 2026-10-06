import { logStoreDefinition } from '@hozon/store-log'
import { telemetryStoreDefinition } from '@hozon/store-telemetry'

import type { OpenLocalDatabaseParams } from '../src/index.js'

export const params: OpenLocalDatabaseParams = {
  app: 'myapp',
  stores: [logStoreDefinition, telemetryStoreDefinition],
}
