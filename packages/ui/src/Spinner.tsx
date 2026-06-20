import { Spinner as InkSpinner } from '@inkjs/ui'
import { Box, Text } from 'ink'

export type SpinnerProps = {
  label?: string
  /** Elapsed time appended as `(Ns)` when provided. */
  elapsedMs?: number
}

/** A spinner with an optional label and elapsed-seconds counter. */
export function Spinner({ label, elapsedMs }: SpinnerProps) {
  const seconds = elapsedMs != null ? ` (${Math.floor(elapsedMs / 1000)}s)` : ''
  return (
    <Box>
      <InkSpinner />
      {label != null ? (
        <Text dimColor>
          {' '}
          {label}
          {seconds}
        </Text>
      ) : null}
    </Box>
  )
}

export default Spinner
