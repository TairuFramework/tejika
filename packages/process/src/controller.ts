import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import type { Client } from '@enkaku/client'
import type { ProtocolDefinition } from '@enkaku/protocol'
import { getSocketPath } from '@tejika/env'
import { createDaemonClient } from './client.js'
import { spawnDaemon } from './daemon.js'
import { safeRemove } from './socket.js'

export type EnsureDaemonOptions = {
  app: string
  /** Daemon entry script spawned when no daemon is reachable. */
  entry: string
  args?: Array<string>
  socketPath?: string
  /** Total time to keep retrying the post-spawn connect. Default 5000ms. */
  timeoutMs?: number
  /** Delay between connect attempts. Default 50ms. */
  intervalMs?: number
}

const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOENT'])

async function connectWithRetry<Protocol extends ProtocolDefinition>(
  opts: EnsureDaemonOptions,
  socketPath: string,
): Promise<Client<Protocol>> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const intervalMs = opts.intervalMs ?? 50
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  for (;;) {
    try {
      return await createDaemonClient<Protocol>({ app: opts.app, socketPath })
    } catch (err) {
      if (!CONNECT_CODES.has((err as NodeJS.ErrnoException).code ?? '')) throw err
      lastError = err
      if (Date.now() >= deadline) throw lastError
      await delay(intervalMs)
    }
  }
}

/**
 * Ensure a daemon is running and return a connected client. Tries to connect;
 * on a missing/refused socket, removes a stale socket file, spawns the daemon,
 * and polls until it is reachable.
 */
export async function ensureDaemon<Protocol extends ProtocolDefinition>(
  opts: EnsureDaemonOptions,
): Promise<Client<Protocol>> {
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  try {
    return await createDaemonClient<Protocol>({ app: opts.app, socketPath })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (!CONNECT_CODES.has(code ?? '')) throw err
    // A refused connection on an existing socket file means a stale socket from
    // a crashed daemon; remove it so the fresh daemon can bind.
    if (code === 'ECONNREFUSED' && existsSync(socketPath)) safeRemove(socketPath)
    await spawnDaemon({ app: opts.app, entry: opts.entry, args: opts.args, socketPath })
    return await connectWithRetry<Protocol>(opts, socketPath)
  }
}
