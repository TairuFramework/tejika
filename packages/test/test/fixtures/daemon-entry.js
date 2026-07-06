import { serve } from '@enkaku/server'
import { runDaemon } from '@tejika/process'

// Minimal daemon for the lifecycle integration test. All paths resolve through
// the profile's env overrides (TEJIKA_E2E_DATA_DIR / TEJIKA_E2E_STATE_DIR):
// socket at <dir>/tejika-e2e.sock, pidfile at <dir>/tejika-e2e.pid.
await runDaemon({
  app: 'tejika-e2e',
  serve: (transport) =>
    serve({
      requireAuth: false,
      handlers: { ping: () => 'pong' },
      transport,
    }),
})
