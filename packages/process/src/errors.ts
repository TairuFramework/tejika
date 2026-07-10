/** A live daemon (or one mid-boot) already holds the lock for this app. */
export class DaemonAlreadyRunningError extends Error {
  readonly code = 'DAEMON_ALREADY_RUNNING' as const
  #pid: number
  #socketPath: string

  constructor(pid: number, socketPath: string) {
    super(`daemon already running (pid ${pid}, socket ${socketPath})`)
    this.name = 'DaemonAlreadyRunningError'
    this.#pid = pid
    this.#socketPath = socketPath
  }

  get pid(): number {
    return this.#pid
  }

  get socketPath(): string {
    return this.#socketPath
  }
}

/** The spawned daemon died (or never bound) before its socket accepted a connection. */
export class DaemonBootError extends Error {
  readonly code = 'DAEMON_BOOT_FAILED' as const
  #logPath: string

  constructor(message: string, details: { logPath: string; cause?: unknown }) {
    super(`${message} — see ${details.logPath}`, { cause: details.cause })
    this.name = 'DaemonBootError'
    this.#logPath = details.logPath
  }

  get logPath(): string {
    return this.#logPath
  }
}
