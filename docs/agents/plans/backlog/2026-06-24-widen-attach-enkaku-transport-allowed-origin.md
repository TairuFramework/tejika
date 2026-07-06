# Widen `attachEnkakuTransport` `allowedOrigin` to `string | Array<string>`

**Priority:** backlog
**Origin:** surfaced while adopting `@tejika/server` in kubun's `connector-explorer` (oclif→tejika CLI adoption, 2026-06-24). Performed in this `tejika` repo.
**Where:** `packages/server/src/server.ts`.

## Problem

`attachEnkakuTransport`'s options type narrows `allowedOrigin` to `string`:

```ts
export function attachEnkakuTransport<Protocol extends ProtocolDefinition>(
  app: Hono,
  opts: { path: string; allowedOrigin?: string },
): ServerTransport<Protocol> {
  const transport = new ServerTransport<Protocol>({ allowedOrigin: opts.allowedOrigin })
  app.all(opts.path, (ctx) => transport.fetch(ctx.req.raw))
  return transport
}
```

But the underlying `@enkaku/http-serve` `ServerTransportOptions.allowedOrigin` accepts `string | Array<string>` and normalizes either form (a bare string becomes a one-element array internally). The helper's narrower type forces a caller that has an origin allowlist array to either change its shape or cast, even though the value would pass straight through to a constructor that already accepts arrays.

A concrete instance: kubun's connector-explorer previously built the transport with `new ServerTransport<GraphProtocol>({ allowedOrigin: ['*'] })`. Adopting `attachEnkakuTransport` required collapsing that to the string `'*'` (behavior-identical, since enkaku normalizes `'*'` → `['*']`) purely to satisfy the type. A real multi-origin allowlist could not be passed without a cast.

## Proposed change

Widen the option to match the underlying transport:

```ts
opts: { path: string; allowedOrigin?: string | Array<string> },
```

No runtime change — `opts.allowedOrigin` is already forwarded verbatim to `new ServerTransport({ allowedOrigin })`, which handles both forms. This is purely a type-surface fix for parity with `ServerTransportOptions`.

## Acceptance

- `attachEnkakuTransport` accepts both a bare string and a string array for `allowedOrigin`.
- `createLocalServer` / any internal callers still typecheck.
- A consumer can pass `['https://a.example', 'https://b.example']` without a cast.

## Notes

Low effort, low risk (one type annotation). Not blocking any current consumer — kubun works today by passing `'*'`.
