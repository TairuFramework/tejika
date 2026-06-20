import { Box } from 'ink'
import type { ReactNode } from 'react'

export type FooterProps = {
  children: ReactNode
}

/** A bordered bottom container for status lines, hints, or an input row. */
export function Footer({ children }: FooterProps) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {children}
    </Box>
  )
}

export default Footer
