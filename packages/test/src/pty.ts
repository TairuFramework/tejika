import { setTimeout as delay } from 'node:timers/promises'
import { type IPty, spawn } from 'node-pty'
import stripAnsi from 'strip-ansi'
import { poll } from './poll.js'

export type PTYDriverOptions = {
  command?: string
  args: Array<string>
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  name?: string
}

export type PTYExit = { exitCode: number; signal?: number }

const ESC = '\u001b'
const ETX = '\u0003'

/**
 * Drives a real terminal app over a PTY (node-pty). Ink and other TUI
 * frameworks need a TTY on stdin (setRawMode), which a plain child_process
 * pipe cannot provide. Output accumulates in a buffer: `screen()` is the
 * ANSI-stripped whole, `mark()`/`screenSince()`/`screenAfterLast()` give
 * windowed views, `waitFor*` poll until text appears. Subclass or wrap it to
 * add app-specific flows. `using driver = new PTYDriver(...)` kills the PTY
 * at scope exit.
 */
export class PTYDriver implements Disposable {
  #pty: IPty
  #buf = ''
  #exit: PTYExit | null = null

  constructor(options: PTYDriverOptions) {
    this.#pty = spawn(options.command ?? 'node', options.args, {
      name: options.name ?? 'xterm-color',
      cols: options.cols ?? 100,
      rows: options.rows ?? 30,
      cwd: options.cwd,
      env: options.env ?? (process.env as Record<string, string>),
    })
    this.#pty.onData((data) => {
      this.#buf += data
    })
    this.#pty.onExit((exit) => {
      this.#exit = exit
    })
  }

  /** ANSI-stripped view of everything rendered so far. */
  screen(): string {
    return stripAnsi(this.#buf).replace(/\r/g, '')
  }

  /** Current raw buffer length — a marker for "output produced after this point". */
  mark(): number {
    return this.#buf.length
  }

  /** ANSI-stripped view of only the output appended after `since` (see mark()). */
  screenSince(since: number): string {
    return stripAnsi(this.#buf.slice(since)).replace(/\r/g, '')
  }

  /**
   * ANSI-stripped view from the LAST occurrence of `marker` onward. Use to
   * isolate the most recent render window after an event that emits a known
   * boundary string, even when the app batches the boundary and the following
   * frame into one data chunk.
   */
  screenAfterLast(marker: string): string {
    const full = this.screen()
    const at = full.lastIndexOf(marker)
    return at === -1 ? '' : full.slice(at)
  }

  /** Resolve true once `text` appears on screen, false on timeout. */
  async waitFor(text: string, timeoutMs = 15_000): Promise<boolean> {
    return (await poll(() => this.screen().includes(text), { timeoutMs })) ?? false
  }

  /** Like waitFor, but only matches output appended after `since` (see mark()). */
  async waitForSince(text: string, since: number, timeoutMs = 15_000): Promise<boolean> {
    return (await poll(() => this.screenSince(since).includes(text), { timeoutMs })) ?? false
  }

  /** Like waitFor, but only matches in the window from the last `marker`. */
  async waitForAfterLast(marker: string, text: string, timeoutMs = 15_000): Promise<boolean> {
    return (await poll(() => this.screenAfterLast(marker).includes(text), { timeoutMs })) ?? false
  }

  /** Resolve with the process exit info once it exits, or null on timeout. */
  async waitForExit(timeoutMs = 8_000): Promise<PTYExit | null> {
    return (await poll(() => this.#exit, { timeoutMs })) ?? null
  }

  write(data: string): void {
    this.#pty.write(data)
  }

  /** Type at human speed; instant writes race TUI renders and autocompletes. */
  async type(text: string, cps = 50): Promise<void> {
    for (const char of text) {
      this.#pty.write(char)
      await delay(1000 / cps)
    }
  }

  enter(): void {
    this.#pty.write('\r')
  }

  esc(): void {
    this.#pty.write(ESC)
  }

  tab(): void {
    this.#pty.write('\t')
  }

  up(): void {
    this.#pty.write(`${ESC}[A`)
  }

  down(): void {
    this.#pty.write(`${ESC}[B`)
  }

  right(): void {
    this.#pty.write(`${ESC}[C`)
  }

  left(): void {
    this.#pty.write(`${ESC}[D`)
  }

  /** Send a single Ctrl+C (^C) without killing the PTY, to drive quit flows. */
  ctrlC(): void {
    this.#pty.write(ETX)
  }

  kill(): void {
    try {
      this.#pty.write(ETX)
      this.#pty.kill()
    } catch {
      // Already exited.
    }
  }

  [Symbol.dispose](): void {
    this.kill()
  }
}
