import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server as NetServer } from 'node:net'
import { dirname, join } from 'node:path'
import type {
  ClientMessage,
  ProtocolDefinition,
  ServerMessage,
  ServerTransportOf,
} from '@enkaku/protocol'
import type { Server } from '@enkaku/server'
import { SocketTransport } from '@enkaku/socket'
import { getDataDir, getPIDPath, getSocketPath } from '@tejika/env'
import spawn from 'nano-spawn'
import { safeRemove, waitForSocket } from './socket.js'
import { getDaemonStatus } from './status.js'

export type RunDaemonOptions<Protocol extends ProtocolDefinition> = {
  app: string
  socketPath?: string
  pidPath?: string
  /** Build the Enkaku server for one accepted connection's transport. */
  serve: (transport: ServerTransportOf<Protocol>) => Server<Protocol>
  /** Optional async cleanup invoked on SIGINT/SIGTERM before the process exits. */
  onShutdown?: () => Promise<void>
}

/**
 * Boot a daemon in the current process and keep it alive until SIGTERM/SIGINT.
 * Refuses to boot beside a live daemon (split-brain guard), removes any stale
 * socket, listens on the unix socket with owner-only (0o600) permissions, writes
 * the pidfile, and installs signal handlers that close the server and clean up
 * the socket + pidfile before exiting. Each connection is served by `opts.serve`.
 */
export async function runDaemon<Protocol extends ProtocolDefinition>(
  opts: RunDaemonOptions<Protocol>,
): Promise<void> {
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  const pidPath = opts.pidPath ?? getPIDPath(opts.app)

  // Refuse to boot beside a live daemon: blindly unlinking the socket below
  // would orphan the running instance (split-brain). getDaemonStatus reaps a
  // stale pidfile itself, so after a crash this still falls through to cleanup.
  const status = getDaemonStatus({ app: opts.app, pidPath })
  if (status.running) {
    throw new Error(`${opts.app} daemon already running (pid ${status.pid})`)
  }

  if (existsSync(socketPath)) safeRemove(socketPath)
  mkdirSync(dirname(socketPath), { recursive: true })
  mkdirSync(dirname(pidPath), { recursive: true })

  const server = createServer((socket) => {
    const transport = new SocketTransport<ClientMessage, ServerMessage>({
      socket,
    }) as unknown as ServerTransportOf<Protocol>
    const handler = opts.serve(transport)
    socket.once('close', () => void handler.dispose())
  })

  await new Promise<NetServer>((resolve, reject) => {
    server.on('error', reject)
    server.listen(socketPath, () => {
      // The socket file's permissions are the only barrier; owner-only keeps
      // other local users from driving the daemon.
      chmodSync(socketPath, 0o600)
      resolve(server)
    })
  })

  writeFileSync(pidPath, String(process.pid), 'utf8')

  const shutdown = async (): Promise<void> => {
    server.close()
    safeRemove(socketPath)
    if (existsSync(pidPath)) rmSync(pidPath)
    await opts.onShutdown?.()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown())
  process.once('SIGINT', () => void shutdown())
}

export type SpawnDaemonOptions = {
  app: string
  /** Path to the daemon entry script run with `node`. Receives `--socket-path <path>`. */
  entry: string
  args?: Array<string>
  socketPath?: string
  logPath?: string
}

/**
 * Spawn the detached daemon process and wait until its socket accepts
 * connections. stdout/stderr append to `logPath` (default `<dataDir>/daemon.log`)
 * so a boot crash is visible instead of surfacing only as a connect timeout.
 */
export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<void> {
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  const logPath = opts.logPath ?? join(getDataDir(opts.app), 'daemon.log')
  mkdirSync(dirname(logPath), { recursive: true })
  mkdirSync(dirname(socketPath), { recursive: true })

  const logFD = openSync(logPath, 'a')
  try {
    const subprocess = spawn(
      'node',
      [opts.entry, '--socket-path', socketPath, ...(opts.args ?? [])],
      {
        detached: true,
        stdio: ['ignore', logFD, logFD],
      },
    )
    // The daemon outlives us and is terminated out-of-band (SIGTERM/SIGKILL), so
    // its eventual exit rejection is expected — swallow it to avoid an unhandled
    // rejection. We only need the child handle to unref it.
    subprocess.catch(() => {})
    // Dereference the child so it can be garbage collected and outlives us.
    const child = await subprocess.nodeChildProcess
    child.unref()
  } finally {
    // The child holds its own copy of the descriptor; release ours.
    closeSync(logFD)
  }
  await waitForSocket(socketPath)
}
