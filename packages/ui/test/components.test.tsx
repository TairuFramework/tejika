import { render } from 'ink-testing-library'
import { describe, expect, test } from 'vitest'

import { ConfirmCard } from '../src/ConfirmCard.js'
import { Footer } from '../src/Footer.js'
import { IconLine } from '../src/IconLine.js'
import { KeyHints } from '../src/KeyHints.js'
import { SelectCard } from '../src/SelectCard.js'
import { Spinner } from '../src/Spinner.js'
import { SystemNotice } from '../src/SystemNotice.js'

const noop = (): void => {}

describe('IconLine', () => {
  test('renders the icon and child text', () => {
    const { lastFrame } = render(
      <IconLine icon="*" color="blue">
        hello
      </IconLine>,
    )
    expect(lastFrame()).toContain('*')
    expect(lastFrame()).toContain('hello')
  })
})

describe('SystemNotice', () => {
  test('renders the notice text', () => {
    const { lastFrame } = render(<SystemNotice variant="error" text="boom" />)
    expect(lastFrame()).toContain('boom')
  })
})

describe('ConfirmCard', () => {
  test('renders the confirmation message', () => {
    const { lastFrame } = render(
      <ConfirmCard message="proceed?" onConfirm={noop} onCancel={noop} />,
    )
    expect(lastFrame()).toContain('proceed?')
  })
})

describe('SelectCard', () => {
  test('renders item labels', () => {
    const { lastFrame } = render(
      <SelectCard
        title="pick one"
        items={[
          { label: 'alpha', value: 'a' },
          { label: 'beta', value: 'b' },
        ]}
        onSelect={noop}
      />,
    )
    expect(lastFrame()).toContain('pick one')
    expect(lastFrame()).toContain('alpha')
  })

  test('renders the empty message when there are no items', () => {
    const { lastFrame } = render(
      <SelectCard items={[]} onSelect={noop} emptyMessage="nothing here" />,
    )
    expect(lastFrame()).toContain('nothing here')
  })
})

describe('Spinner', () => {
  test('renders the label and elapsed seconds', () => {
    const { lastFrame } = render(<Spinner label="loading" elapsedMs={3000} />)
    expect(lastFrame()).toContain('loading')
    expect(lastFrame()).toContain('(3s)')
  })
})

describe('KeyHints', () => {
  test('renders each hint as [keys] label', () => {
    const { lastFrame } = render(
      <KeyHints
        hints={[
          { keys: 'esc', label: 'cancel' },
          { keys: 'enter', label: 'confirm' },
        ]}
      />,
    )
    expect(lastFrame()).toContain('[esc] cancel')
    expect(lastFrame()).toContain('[enter] confirm')
  })
})

describe('Footer', () => {
  test('renders its children', () => {
    const { lastFrame } = render(
      <Footer>
        <KeyHints hints={[{ keys: 'q', label: 'quit' }]} />
      </Footer>,
    )
    expect(lastFrame()).toContain('[q] quit')
  })
})
