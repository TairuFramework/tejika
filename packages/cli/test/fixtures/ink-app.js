import { Text, useApp, useInput } from 'ink'
import { createElement, useState } from 'react'

import { runInk } from '../../lib/index.js'

function App() {
  const { exit } = useApp()
  const [last, setLast] = useState('none')
  useInput((input, key) => {
    if (input === 'q') exit()
    else if (key.return) setLast('enter')
    else if (input !== '') setLast(input)
  })
  return createElement(Text, null, `last:${last}`)
}

await runInk(createElement(App))
