import { Box, Text } from 'ink'

export type KeyHint = { keys: string; label: string }

export type KeyHintsProps = {
  hints: Array<KeyHint>
}

/** A dimmed row of `[keys] label` hints, e.g. `[esc] cancel  [enter] confirm`. */
export function KeyHints({ hints }: KeyHintsProps) {
  return (
    <Box>
      <Text dimColor>{hints.map((hint) => `[${hint.keys}] ${hint.label}`).join('  ')}</Text>
    </Box>
  )
}

export default KeyHints
