import { Select } from '@inkjs/ui'
import { Box, Text, useInput } from 'ink'

export type SelectItem = { label: string; value: string }

export type SelectCardProps = {
  title?: string
  items: Array<SelectItem>
  onSelect: (value: string) => void
  onCancel?: () => void
  /** Message shown when `items` is empty. */
  emptyMessage?: string
}

/** A bordered single-choice list. Esc cancels (when `onCancel` is provided). */
export function SelectCard({ title, items, onSelect, onCancel, emptyMessage }: SelectCardProps) {
  useInput((_input, key) => {
    if (key.escape) onCancel?.()
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan">
      {title != null ? <Text color="cyan">{title}</Text> : null}
      {items.length === 0 ? (
        <Text dimColor>{emptyMessage ?? 'no items'}</Text>
      ) : (
        <Select options={items} onChange={(value) => onSelect(value)} />
      )}
      {onCancel != null ? <Text dimColor>[esc] cancel</Text> : null}
    </Box>
  )
}

export default SelectCard
