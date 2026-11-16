import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: { 'socket-path': { type: 'string' }, 'pid-path': { type: 'string' } },
})
const end = Date.now() + 5000
while (!existsSync(`${values['pid-path']}.admitted`)) {
  if (Date.now() >= end) process.exit(1)
  await delay(10)
}
await import('./daemon-entry.js')
