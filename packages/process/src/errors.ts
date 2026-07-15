/**
 * A live daemon (or one mid-boot) already holds the socket for this app.
 *
 * `pid` is OPTIONAL, and undefined when the daemon is known only by its socket — a foreign
 * daemon listening with no state record to name it. It used to be `-1` there, which handed
 * a consumer doing `process.kill(err.pid, 'SIGTERM')` a weapon rather than a pid:
 * `kill(-1, sig)` signals every process the user may signal, and `kill(0, sig)` the caller's
 * whole process group. A pid this package cannot vouch for is now simply absent.
 */
export class DaemonAlreadyRunningError extends Error {
  #code = 'DAEMON_ALREADY_RUNNING' as const
  #pid?: number
  #socketPath: string

  constructor(pid: number | undefined, socketPath: string) {
    super(
      pid == null
        ? `daemon already running (unknown pid, socket ${socketPath})`
        : `daemon already running (pid ${pid}, socket ${socketPath})`,
    )
    this.name = 'DaemonAlreadyRunningError'
    this.#pid = pid
    this.#socketPath = socketPath
  }

  /** Literal-typed on purpose: `code` stays a discriminant callers can narrow on. */
  get code(): 'DAEMON_ALREADY_RUNNING' {
    return this.#code
  }

  /** Undefined when the running daemon holds the socket without a state record naming it. */
  get pid(): number | undefined {
    return this.#pid
  }

  get socketPath(): string {
    return this.#socketPath
  }
}

/** The spawned daemon died (or never bound) before its socket accepted a connection. */
export class DaemonBootError extends Error {
  #code = 'DAEMON_BOOT_FAILED' as const
  #logPath: string

  constructor(message: string, details: { logPath: string; cause?: unknown }) {
    super(`${message} — see ${details.logPath}`, { cause: details.cause })
    this.name = 'DaemonBootError'
    this.#logPath = details.logPath
  }

  /** Literal-typed on purpose: `code` stays a discriminant callers can narrow on. */
  get code(): 'DAEMON_BOOT_FAILED' {
    return this.#code
  }

  get logPath(): string {
    return this.#logPath
  }
}
