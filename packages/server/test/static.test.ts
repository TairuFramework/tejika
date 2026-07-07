import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { injectToken, serveStaticSPA } from '../src/static.js'

describe('injectToken', () => {
  test('injects the token as a JSON global inside head', () => {
    const out = injectToken('<html><head></head><body></body></html>', 'abc123')
    expect(out).toContain('<script>window.__APP_TOKEN__="abc123"</script></head>')
  })

  test('unicode-escapes < and > so a "</script>" token cannot break out', () => {
    const out = injectToken('<head></head>', '</script><script>alert(1)</script>')
    expect(out).not.toContain('</script><script>alert(1)')
    expect(out).toContain('\\u003c/script\\u003e')
  })

  test('does not expand a $&-style token via string replace', () => {
    const out = injectToken('<head></head>', 'a$&b')
    // A raw String.replace would turn $& into the matched "</head>"; the replacer must not.
    expect(out).toContain('window.__APP_TOKEN__="a$&b"')
    expect(out).not.toContain('a</head>b')
  })
})

describe('serveStaticSPA', () => {
  let dir: string
  let app: Hono
  const cwd = process.cwd()

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tejika-static-'))
    await writeFile(join(dir, 'index.html'), '<head></head><body>app</body>')
    await writeFile(join(dir, 'asset.txt'), 'hello-asset')
    app = new Hono()
  })

  afterEach(() => {
    process.chdir(cwd)
  })

  test('serves the token-injected index at /', async () => {
    serveStaticSPA(app, { dir, token: 'tok' })
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('window.__APP_TOKEN__="tok"')
  })

  test('serves assets from an absolute root even after chdir', async () => {
    serveStaticSPA(app, { dir, token: 'tok' })
    process.chdir(tmpdir()) // a daemon-style chdir must not re-point the static root
    const res = await app.request('/asset.txt')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello-asset')
  })

  test('returns 404 (not the SPA index) for an unknown /api path', async () => {
    serveStaticSPA(app, { dir, token: 'tok' })
    const res = await app.request('/api/does-not-exist')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('window.__APP_TOKEN__')
  })

  test('serves the SPA index for an unknown non-/api path', async () => {
    serveStaticSPA(app, { dir, token: 'tok' })
    const res = await app.request('/some/client/route')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('window.__APP_TOKEN__="tok"')
  })
})
