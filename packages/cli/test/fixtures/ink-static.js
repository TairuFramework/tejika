import { Text } from 'ink'
import { createElement } from 'react'

import { renderStatic } from '../../lib/index.js'

renderStatic(createElement(Text, null, 'static:done'))
