import { renderTable } from '../../lib/index.js'

renderTable(
  [
    { key: 'id', label: 'ID' },
    { key: 'state', label: 'STATE' },
  ],
  [
    { id: 'a', state: 'running' },
    { id: 'longer', state: 'done' },
  ],
)
