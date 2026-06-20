import { parseArgs } from 'node:util'
import { serve } from '@enkaku/server'
import { runDaemon } from '../../src/index.js'

// Trivial daemon entry used by the spawn/reconnect integration test. Run with
// `node --import tsx` so the spawned process executes this TypeScript directly.
const { values } = parseArgs({
  options: { 'socket-path': { type: 'string' } },
  strict: false,
})

const protocol = {
  ping: { type: 'request', result: { type: 'string' } },
} as const

await runDaemon<typeof protocol>({
  app: 'tejika-test',
  socketPath: values['socket-path'] as string,
  serve: (transport) =>
    serve<typeof protocol>({
      requireAuth: false,
      handlers: { ping: () => 'pong' },
      transport,
    }),
})
