import { render } from 'ink-testing-library'
import { describe, expect, test } from 'vitest'

import { StatusLine } from '../src/StatusLine.js'

describe('StatusLine', () => {
  test('renders the provided label', () => {
    const { lastFrame } = render(<StatusLine label="ready" />)
    expect(lastFrame()).toContain('ready')
  })
})
