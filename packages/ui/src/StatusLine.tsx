import { Spinner } from '@inkjs/ui'
import { Box, Text, type TextProps } from 'ink'

export type StatusLineProps = {
  label: string
  icon?: string
  color?: TextProps['color']
  /** Show a spinner ahead of the label (e.g. while busy). */
  busy?: boolean
}

/** A single status line: optional spinner/icon followed by a coloured label. */
export function StatusLine({ label, icon, color, busy }: StatusLineProps) {
  return (
    <Box>
      {busy ? <Spinner /> : null}
      {busy ? <Text> </Text> : null}
      {icon != null ? <Text color={color}>{icon} </Text> : null}
      <Text color={color}>{label}</Text>
    </Box>
  )
}
