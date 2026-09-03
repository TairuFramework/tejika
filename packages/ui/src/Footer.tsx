import { Box, type TextProps } from 'ink'
import type { ReactNode } from 'react'

export type FooterProps = {
  children: ReactNode
  /** Border color, default 'gray'. */
  borderColor?: TextProps['color']
}

/** A bordered bottom container for status lines, hints, or an input row. */
export function Footer({ children, borderColor = 'gray' }: FooterProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={borderColor} paddingX={1}>
      {children}
    </Box>
  )
}

export default Footer
