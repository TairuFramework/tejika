import { Box, Text, type TextProps } from 'ink'
import type { ReactNode } from 'react'

export type IconLineProps = {
  icon: string
  color?: TextProps['color']
  dim?: boolean
  /** Text content rendered inside a single `<Text>`; a `<Box>` child is unsupported (Ink crashes). */
  children: ReactNode
}

/**
 * Two-column line: a fixed narrow left column holding a single-character icon,
 * and a flexible right column whose text wraps full width. Continuation lines
 * hang-indent under the right column, keeping lines aligned without a wide label.
 */
export function IconLine({ icon, color, dim, children }: IconLineProps) {
  return (
    <Box>
      <Box flexShrink={0} width={2}>
        <Text color={color} dimColor={dim}>
          {icon}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text dimColor={dim}>{children}</Text>
      </Box>
    </Box>
  )
}
