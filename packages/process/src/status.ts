import { readFileSync, rmSync } from 'node:fs'
import { getPidPath } from '@tejika/env'

export type DaemonStatus = { running: boolean; pid?: number; stale: boolean }

export function getDaemonStatus(opts: { app: string; pidPath?: string }): DaemonStatus {
  const pidPath = opts.pidPath ?? getPidPath(opts.app)
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
  } catch {
    return { running: false, stale: false }
  }
  try {
    process.kill(pid, 0)
    return { running: true, pid, stale: false }
  } catch {
    rmSync(pidPath, { force: true })
    return { running: false, pid, stale: true }
  }
}

export async function stopDaemon(opts: { app: string; pidPath?: string }): Promise<void> {
  const status = getDaemonStatus(opts)
  if (status.running && status.pid != null) process.kill(status.pid, 'SIGTERM')
}
