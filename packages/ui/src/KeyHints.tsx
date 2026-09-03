import { Box, Text } from 'ink'

export type KeyHint = { keys: string; label: string }

export type KeyHintsProps = {
  hints: Array<KeyHint>
}

/** A dimmed, wrapping row of `[keys] label` hints; wraps between hints, not mid-hint. */
export function KeyHints({ hints }: KeyHintsProps) {
  return (
    <Box flexWrap="wrap" columnGap={2}>
      {hints.map((hint) => (
        <Box key={`${hint.keys}:${hint.label}`}>
          <Text dimColor>{`[${hint.keys}] ${hint.label}`}</Text>
        </Box>
      ))}
    </Box>
  )
}
