import { Select } from '@inkjs/ui'
import { Box, Text, type TextProps, useInput } from 'ink'

export type SelectItem<T = string> = { label: string; value: T }

export type SelectCardProps<T = string> = {
  title?: string
  items: Array<SelectItem<T>>
  onSelect: (value: T) => void
  onCancel?: () => void
  /** Message shown when `items` is empty. */
  emptyMessage?: string
  /** When false, the card and its list ignore all key input. Defaults to true. */
  isActive?: boolean
  /** Title text color. */
  titleColor?: TextProps['color']
  /** Border color. */
  borderColor?: TextProps['color']
}

/**
 * A bordered single-choice list. Esc cancels (when `onCancel` is provided).
 *
 * Selection is keyed by position for the card's mount. Changing the list's
 * length or an item's label resets/remaps selection, but reordering items
 * with identical labels may not (`@inkjs/ui`'s `Select` only resets when its
 * mapped options are deeply unequal). Callers needing selection to survive
 * list changes should remount with a stable React `key`. An empty list with
 * no `onCancel` is an intentionally terminal presentational state; the
 * caller controls unmounting.
 */
export function SelectCard<T = string>({
  title,
  items,
  onSelect,
  onCancel,
  emptyMessage,
  isActive = true,
  titleColor = 'cyan',
  borderColor = 'cyan',
}: SelectCardProps<T>) {
  useInput(
    (_input, key) => {
      if (key.escape) onCancel?.()
    },
    { isActive: isActive && onCancel != null },
  )

  const options = items.map((item, index) => ({ label: item.label, value: String(index) }))

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor}>
      {title != null ? <Text color={titleColor}>{title}</Text> : null}
      {items.length === 0 ? (
        <Text dimColor>{emptyMessage ?? 'no items'}</Text>
      ) : (
        <Select
          isDisabled={!isActive}
          options={options}
          onChange={(value) => {
            const item = items[Number(value)]
            if (item != null) onSelect(item.value)
          }}
        />
      )}
      {onCancel != null ? <Text dimColor>[esc] cancel</Text> : null}
    </Box>
  )
}
