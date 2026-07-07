import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Context, Hono } from 'hono'

/**
 * Splice a secret token into served HTML as a global the SPA reads. The token is
 * JSON-encoded so a token value can never break out of the <script> element, and
 * `<`/`>` are unicode-escaped so even a pathological token containing
 * "</script>" cannot close the injected block. The head insertion uses a replacer
 * function so a `$&`/`$1`-style token cannot expand during String.replace.
 */
export function injectToken(html: string, token: string): string {
  const safeJSON = JSON.stringify(token).replace(/[<>]/g, (c) =>
    c === '<' ? '\\u003c' : '\\u003e',
  )
  const tag = `<script>window.__APP_TOKEN__=${safeJSON}</script>`
  return html.includes('</head>') ? html.replace('</head>', () => `${tag}</head>`) : `${tag}${html}`
}

/**
 * Serve a static SPA from `opts.dir`: the entry point and the non-`/api`
 * not-found fallback both return `index.html` with the token injected; real asset
 * files are served by `serveStatic`. The root is resolved to an absolute path so a
 * later `process.chdir` (common in daemons) cannot re-point or break serving, and
 * so cross-drive paths work on Windows. Unknown `/api/*` paths return a real 404
 * instead of the HTML index.
 */
export function serveStaticSPA(app: Hono, opts: { dir: string; token: string }): void {
  const root = resolve(opts.dir)
  const indexPath = join(root, 'index.html')
  const renderIndex = async (ctx: Context): Promise<Response> =>
    ctx.html(injectToken(await readFile(indexPath, 'utf8'), opts.token))
  app.get('/', renderIndex)
  app.use('/*', serveStatic({ root }))
  app.notFound((ctx) => {
    const path = ctx.req.path
    return path === '/api' || path.startsWith('/api/')
      ? ctx.text('Not Found', 404)
      : renderIndex(ctx)
  })
}
