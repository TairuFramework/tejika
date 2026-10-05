import { parseArgs } from 'node:util'
import { serve } from '@enkaku/server'
import { runDaemon } from '@tejika/process'

// Daemon for the createDaemonCommand integration test. spawnDaemon always passes
// `--socket-path` and `--pid-path`.
const { values } = parseArgs({
  options: { 'socket-path': { type: 'string' }, 'pid-path': { type: 'string' } },
  strict: false,
})

await runDaemon({
  app: 'tejika-cli-test',
  socketPath: values['socket-path'],
  pidPath: values['pid-path'],
  serve: (transport) => serve({ requireAuth: false, handlers: { ping: () => 'pong' }, transport }),
})
