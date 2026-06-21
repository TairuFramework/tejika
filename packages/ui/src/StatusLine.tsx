import { Spinner } from '@inkjs/ui'
import { Box, Text } from 'ink'

export type StatusLineProps = {
  label: string
  icon?: string
  color?: string
  /** Show a spinner ahead of the label (e.g. while busy). */
  busy?: boolean
}

/** A single status line: optional spinner/icon followed by a coloured label. */
export function StatusLine({ label, icon, color, busy }: StatusLineProps) {
  return (
    <Box>
      {busy ? <Spinner /> : null}
      {icon != null ? <Text color={color}>{icon} </Text> : null}
      <Text color={color}>{label}</Text>
    </Box>
  )
}

export default StatusLine
