import { useApp } from 'ink'
import { type ReactNode, useEffect } from 'react'

export type ExitOnAbortProps = {
  signal: AbortSignal
  children?: ReactNode
}

/** Exits the surrounding Ink app (unmounting its content) when `signal` aborts. */
export function ExitOnAbort({ signal, children }: ExitOnAbortProps) {
  const { exit } = useApp()
  useEffect(() => {
    if (signal.aborted) {
      exit()
      return
    }
    const onAbort = () => exit()
    signal.addEventListener('abort', onAbort, { once: true })
    return () => signal.removeEventListener('abort', onAbort)
  }, [signal, exit])
  return children
}
