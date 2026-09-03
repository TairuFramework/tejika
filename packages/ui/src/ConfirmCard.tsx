import { Box, Text, type TextProps, useInput } from 'ink'
import { useRef } from 'react'

import { KeyHints } from './KeyHints.js'

export type ConfirmCardProps = {
  message: string
  /**
   * Fired at most once per mount. The callback owns its own user-facing error
   * reporting; a synchronous throw or a rejected promise is swallowed only as a
   * crash-safety net so it cannot break the render.
   */
  onConfirm: () => void | Promise<void>
  onCancel: () => void | Promise<void>
  /** When false, the card ignores all key input. Defaults to true. */
  isActive?: boolean
  /** Message text color. */
  color?: TextProps['color']
  /** Border color. */
  borderColor?: TextProps['color']
}

/** A yes/no confirmation card: y/enter confirms, n/esc cancels. */
export function ConfirmCard({
  message,
  onConfirm,
  onCancel,
  isActive = true,
  color = 'yellow',
  borderColor = 'yellow',
}: ConfirmCardProps) {
  const fired = useRef(false)
  const run = (callback: () => void | Promise<void>) => {
    if (fired.current) return
    fired.current = true
    try {
      const result = callback()
      if (result != null && typeof (result as Promise<void>).then === 'function') {
        void (result as Promise<void>).catch(() => {})
      }
    } catch {
      // crash-safety net: the callback owns user-facing error reporting.
    }
  }

  useInput(
    (input, key) => {
      if (key.escape) {
        run(onCancel)
        return
      }
      const ch = input.toLowerCase()
      if (ch === 'y' || key.return) run(onConfirm)
      else if (ch === 'n') run(onCancel)
    },
    { isActive },
  )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor}>
      <Text color={color}>{message}</Text>
      <KeyHints
        hints={[
          { keys: 'y / enter', label: 'confirm' },
          { keys: 'n / esc', label: 'cancel' },
        ]}
      />
    </Box>
  )
}
