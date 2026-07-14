// Re-exported because it can now escape `runDaemon`: a boot that cannot take the mutex
// within `lockTimeoutMs` throws it, and callers need something to catch. Deliberately
// distinct from `DaemonAlreadyRunningError` — "someone is booting or stopping and will not
// let go" is not "someone is already serving".
export { TimeoutInterruption } from '@sozai/lock'
export {
  type CreateDaemonClientOptions,
  createDaemonClient,
  createDaemonTransport,
  type DaemonTransport,
} from './client.js'
export { type EnsureDaemonOptions, ensureDaemon } from './controller.js'
export { type DaemonHandle, type RunDaemonOptions, runDaemon } from './daemon.js'
export { createDeadline, type Deadline } from './deadline.js'
export { DaemonAlreadyRunningError, DaemonBootError } from './errors.js'
export {
  type ConnectSocket,
  classifyConnectError,
  isSocketLive,
  probeSocket,
  type SocketProbe,
  waitForSocket,
} from './socket.js'
export { type SpawnDaemonOptions, spawnDaemon } from './spawn.js'
export type { DaemonState } from './state.js'
export { type DaemonStatus, getDaemonStatus } from './status.js'
export { type StopDaemonOptions, type StopResult, stopDaemon } from './stop.js'
