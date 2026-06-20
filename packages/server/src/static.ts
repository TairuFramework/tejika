import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Context, Hono } from 'hono'

/**
 * Splice a secret token into served HTML as a global the SPA reads. The token is
 * JSON-encoded so a token value can never break out of the <script> element, and
 * `<`/`>` are unicode-escaped so even a pathological token containing
 * "</script>" cannot close the injected block.
 */
export function injectToken(html: string, token: string): string {
  const safeJSON = JSON.stringify(token).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  const tag = `<script>window.__APP_TOKEN__=${safeJSON}</script>`
  return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : `${tag}${html}`
}

/**
 * Serve a static SPA from `opts.dir`: the entry point and the not-found fallback
 * both return `index.html` with the token injected; real asset files are served
 * by `serveStatic`.
 */
export function serveStaticSPA(app: Hono, opts: { dir: string; token: string }): void {
  const indexPath = join(opts.dir, 'index.html')
  const renderIndex = async (ctx: Context): Promise<Response> =>
    ctx.html(injectToken(await readFile(indexPath, 'utf8'), opts.token))
  app.get('/', renderIndex)
  app.use('/*', serveStatic({ root: relative(process.cwd(), opts.dir) }))
  app.notFound(renderIndex)
}
