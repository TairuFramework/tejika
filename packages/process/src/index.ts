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
export type { LockRecord } from './lock.js'
export {
  type ConnectSocket,
  classifyConnectError,
  isSocketLive,
  probeSocket,
  type SocketProbe,
  waitForSocket,
} from './socket.js'
export { type SpawnDaemonOptions, spawnDaemon } from './spawn.js'
export { type DaemonStatus, getDaemonStatus } from './status.js'
export { type StopDaemonOptions, type StopResult, stopDaemon } from './stop.js'
