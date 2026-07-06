// Raw-stdin fixture for PTYDriver tests. Prints markers the tests wait on.
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.setEncoding('utf8')
let typed = ''
console.log('\u001b[32mready\u001b[0m')
process.stdin.on('data', (key) => {
  switch (key) {
    case '\u0003': // ^C -- interrupt marker, stays alive (tests single-^C behavior)
      console.log('interrupted')
      break
    case 'q':
      process.exit(0)
      break
    case '\u001b[B': // down arrow
      console.log('down-arrow')
      break
    case '\r':
      console.log(`submitted:${typed}`)
      typed = ''
      break
    default:
      typed += key
  }
})
