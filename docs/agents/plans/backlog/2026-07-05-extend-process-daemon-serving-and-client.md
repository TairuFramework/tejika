# Extend `@tejika/process` daemon serving + client for signing wrappers and domain clients

**Priority:** backlog
**Origin:** surfaced while adopting `@tejika/process` in Sakui's CLI (tejika refactor Phase C, 2026-07-05). Sakui adopted `getDaemonStatus`/`stopDaemon`/`spawnDaemon` fully, but had to keep its own daemon *serving* loop and its own reconnecting *client* bespoke because of the two seams below. Filed here per the stop-and-report rule.
**Where:** `packages/process/src/daemon.ts` (P1), `packages/process/src/client.ts` (P2).

Both seams are the same shape: `@tejika/process` builds the connection `SocketTransport` (server side) / the `Client` (client side) internally and hands back a finished object, leaving no hook for a consumer that needs to (a) wrap the connection stream, or (b) supply its own Client subtype.

---

## P1 — `runDaemon`: let the consumer build the connection transport

`runDaemon`'s `serve` callback receives an already-constructed transport:

```ts
export type RunDaemonOptions<Protocol extends ProtocolDefinition> = {
  app: string
  // …
  serve: (transport: ServerTransportOf<Protocol>) => Server<Protocol>
}
```

and internally:

```ts
const server = createServer((socket) => {
  const transport = new SocketTransport<ClientMessage, ServerMessage>({ socket })
    as unknown as ServerTransportOf<Protocol>
  const handler = opts.serve(transport)
  socket.once('close', () => void handler.dispose())
})
```

### Problem

A consumer that must transform the connection *before* the transport exists cannot use this. Sakui's daemon holds a signing identity and must rewrite the raw readable to sign channel tokens flagged `needsChannelSigning` on the way in — it does `createTransportStream(socket)`, pipes the readable through a `mapAsync` that signs, then builds the `Transport` from the wrapped stream. `runDaemon` gives it only the finished `SocketTransport`, with no access to the socket or the stream, so there is nowhere to inject that middleware. Result: Sakui reimplements the entire `createServer`/listen/chmod/pidfile/shutdown loop just to keep the stream wrap.

### Proposed change

Add an optional per-connection transport factory that defaults to today's behaviour, so a consumer can build the transport (with stream middleware) from the raw socket:

```ts
export type RunDaemonOptions<Protocol extends ProtocolDefinition> = {
  app: string
  // …
  serve: (transport: ServerTransportOf<Protocol>) => Server<Protocol>
  /** Build the per-connection transport from the raw socket. Defaults to
   *  `new SocketTransport({ socket })`. Lets a consumer wrap the connection
   *  stream (e.g. sign/transform messages) before the transport exists. */
  createTransport?: (socket: Socket) => ServerTransportOf<Protocol>
}
```

and internally:

```ts
const transport = opts.createTransport
  ? opts.createTransport(socket)
  : (new SocketTransport<ClientMessage, ServerMessage>({ socket }) as unknown as ServerTransportOf<Protocol>)
```

No behaviour change when `createTransport` is omitted. Generic — no Sakui specifics land upstream; the signing logic stays in the consumer's factory.

### Acceptance

- `runDaemon` without `createTransport` behaves exactly as today.
- A consumer can supply `createTransport` and observe its transport used for every accepted connection, with the same `socket.once('close', …)` disposal.
- Sakui can delete its bespoke serving loop and pass a signing `createTransport`.

---

## P2 — factor a `createDaemonTransport` seam out of `createDaemonClient`

`createDaemonClient` returns a fully-built Enkaku `Client`:

```ts
export async function createDaemonClient<Protocol extends ProtocolDefinition>(
  opts: CreateDaemonClientOptions,
): Promise<Client<Protocol>> { /* builds firstTransport + nextTransport + new Client(...) */ }
```

### Problem

The reconnect plumbing (initial transport, the `handleTransportDisposed`/`handleTransportError` reconnect hooks with exponential backoff, the dispose→abort wiring) is valuable and non-trivial — but it is welded to `new Client<Protocol>(...)` at the end. A consumer that needs a *domain* client cannot reuse it: Sakui wraps the connection in `RuntimeClient` (from `@sakui/runtime-client`), and Enkaku clients don't nest, so there is no way to get a `RuntimeClient` that rides tejika's reconnect. Sakui therefore duplicates the whole `createDaemonClient` body (~60 lines of transport/backoff/dispose logic) just to swap the final constructor.

### Proposed change

Extract the transport + hooks into a `createDaemonTransport` that both `createDaemonClient` and a domain-client consumer can use:

```ts
export type DaemonTransport<Protocol extends ProtocolDefinition> = {
  transport: ClientTransportOf<Protocol>
  handleTransportDisposed: () => ClientTransportOf<Protocol> | undefined
  handleTransportError: () => ClientTransportOf<Protocol> | undefined
  /** Abort reconnection; wire to the domain client's dispose/`disposing`. */
  dispose: () => void
}

export function createDaemonTransport<Protocol extends ProtocolDefinition>(
  opts: CreateDaemonClientOptions,
): Promise<DaemonTransport<Protocol>>
```

`createDaemonClient` then becomes a thin wrapper: build the `DaemonTransport`, pass its three fields into `new Client<Protocol>(...)`, and wire `client.events.on('disposing', dispose)`. A consumer with a `Client` subtype does the same with its own constructor.

### Acceptance

- `createDaemonClient` keeps its current signature and behaviour, implemented over `createDaemonTransport`.
- A consumer can call `createDaemonTransport` and pass `{ transport, handleTransportDisposed, handleTransportError }` into its own `Client` subclass, wiring `dispose` to that client's teardown.
- Sakui can rebuild its `RuntimeClient` daemon connection on `createDaemonTransport`, deleting the duplicated reconnect body.

---

## Notes

Independent of each other; P1 unblocks adopting `runDaemon`-serving, P2 unblocks the domain client. Both are additive (optional option / extracted-but-still-wrapped function) — no breaking change to current `@tejika/process` consumers. When both land, Sakui's `apps/cli/src/daemon/host.ts` serving loop and `controller.ts` `createDaemonClient` can be removed in favour of the tejika primitives with a thin signing/domain shim.
