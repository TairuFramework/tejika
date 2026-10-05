import { useInput } from 'ink'
import type { ReactNode } from 'react'

export type InterruptOnCtrlCProps = {
  /**
   * Called on Ctrl+C. Default: re-raise `SIGINT` on this process, because Ink's raw mode
   * swallows the terminal's own SIGINT. Pair with `exitOnCtrlC: false` so the app does not exit
   * at once, and with a signal handler (e.g. `withCommandSignal`) that aborts the work.
   */
  onInterrupt?: () => void
  children?: ReactNode
}

/** Calls a handler on Ctrl+C instead of exiting the Ink app at once. */
export function InterruptOnCtrlC({
  onInterrupt = () => {
    process.kill(process.pid, 'SIGINT')
  },
  children,
}: InterruptOnCtrlCProps) {
  useInput((input, key) => {
    if (key.ctrl && input === 'c') onInterrupt()
  })
  return children
}
