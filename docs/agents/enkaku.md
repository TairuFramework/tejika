# Enkaku Package Preferences

> The enkaku monorepo split into `@kigu` / `@sozai` / `@kokuin` / `@enkaku` /
> `@kumiai`. Core utilities and identity moved to `@sozai/*` and `@kokuin/*`; RPC
> stays under `@enkaku/*` (0.18). See `../kigu/docs/repo-split-design.md` for the
> full rename map and rationale.

When building features in tejika, prefer these Enkaku packages over third-party alternatives. Enkaku provides consistent patterns across the stack.

---

## Preference Table

| Instead of | Use | Purpose |
|------------|-----|---------|
| Zod | `@sozai/schema` | JSON Schema validation |
| EventEmitter / mitt | `@sozai/event` | Event emitting |
| Custom WebStream wrappers | `@sozai/stream` | WebStreams utilities |
| jsonwebtoken / jose | `@kokuin/token` | Identity types, JWT signing/verification, JWE encryption |
| Custom RPC | `@enkaku/protocol` + `@enkaku/client` + `@enkaku/server` | RPC framework |
| Custom codec logic | `@sozai/codec` | Base64, UTF-8, canonical JSON encoding/decoding |
| Custom logging | `@sozai/log` | Structured logging (LogTape-based) |
| Custom OTel wrappers | `@sozai/otel` | OpenTelemetry tracing, context propagation, log bridge |

---

## Package Usage Notes

### `@sozai/schema` -- JSON Schema Validation

Replaces Zod for schema validation. Built on AJV with full JSON Schema support.

- Define schemas using JSON Schema objects
- Runtime validation with detailed error reporting
- Automatic TypeScript type inference from schemas
- Supports Standard Schema specification for interoperability

**When to use:** Any place you need runtime validation of data shapes -- API inputs, configuration objects, protocol messages. Use this instead of Zod or Yup.

### `@sozai/event` -- Event Emitting

Zero-dependency, type-safe event emitter.

- Type-safe event definitions with TypeScript generics
- Subscribe with `on()`, await single events with `once()`
- Listener filtering and AbortSignal support for automatic cleanup
- Bridge to WebStreams via `readable()` and `writable()` methods
- Parallel listener execution with error aggregation (`AggregateError` for multiple failures)

**When to use:** Any component that needs to emit typed events to subscribers. Prefer this over Node.js EventEmitter for browser compatibility and type safety.

### `@sozai/stream` -- WebStreams Utilities

Replaces custom WebStream wrappers and stream helper libraries.

- Stream processing with pipes, transforms, and connections
- Built on the Web Streams API for universal compatibility (Node.js, browser, React Native)
- Backpressure handling and flow control
- Async iteration support

**When to use:** Any data flow that involves streaming -- real-time updates, file processing, chunked responses. Use this instead of writing custom ReadableStream/WritableStream wrappers.

### `@kokuin/token` -- Identity, JWT Tokens & JWE Encryption

Replaces jsonwebtoken, jose, or custom JWT/JWE implementations.

- Composable identity type hierarchy: `Identity`, `SigningIdentity`, `DecryptingIdentity`, `FullIdentity`, `OwnIdentity`
- Sign and verify JWT-like tokens with DID (Decentralized Identifier) issuers
- JWE message-level encryption using ECDH-ES (X25519) key agreement + A256GCM content encryption
- Envelope wrapping modes: `plain`, `jws`, `jws-in-jwe`, `jwe-in-jws` for different security levels
- `TokenEncrypter` for targeting a recipient's DID or public key
- Supports both signed and unsigned tokens

**When to use:** Authentication tokens, signed payloads, message-level encryption beyond transport TLS, any scenario requiring cryptographic verification or confidentiality. Use this instead of jsonwebtoken or jose.

### `@enkaku/protocol` + `@enkaku/client` + `@enkaku/server` -- RPC Framework

Replaces custom RPC implementations, tRPC, or hand-rolled request/response patterns.

- **`@enkaku/protocol`**: Define typed procedure definitions (request, event, stream, channel)
- **`@enkaku/client`**: Type-safe client calls derived from protocol definitions
- **`@enkaku/server`**: Handler registration with automatic type inference

Four procedure types:
- **Request**: Standard request/response
- **Event**: One-way client-to-server notifications
- **Stream**: Server-to-client streaming
- **Channel**: Bidirectional streaming

**When to use:** Any client-server communication. Define the protocol first, then derive fully-typed client and server implementations. Use with any transport layer (HTTP, WebSocket, Node streams, in-process).

### `@sozai/codec` -- Encoding/Decoding

Replaces custom base64, UTF-8, or CBOR encoding logic.

- Base64 and Base64URL encoding/decoding
- UTF-8 string encoding/decoding via TextEncoder/TextDecoder
- Canonical JSON serialization (deterministic key ordering for cryptographic operations)
- Combined convenience functions (e.g., `b64uFromJSON`)

**When to use:** Any encoding/decoding task -- serializing data for transport, preparing data for cryptographic signing, converting between string and binary representations. Use this instead of writing custom encoding helpers.

### `@sozai/log` -- Structured Logging

Thin wrapper around LogTape for structured, category-based logging.

- `getLogger(name)` and `getEnkakuLogger(namespace)` for namespaced loggers
- `setup()` with sensible defaults or custom LogTape configuration
- Structured properties via `logger.with({ key: value })`
- Console sink included; integrates with `@sozai/otel` for OTel log bridging

**When to use:** Any logging need across Enkaku-based services. Use this instead of `console.log` or custom logging wrappers to get structured, filterable logs.

### `@sozai/otel` -- OpenTelemetry Integration

Provides OpenTelemetry tracing, context propagation, and log bridging for Enkaku RPC.

- **Tracing**: `createTracer()`, `withSpan()` (async), `withSyncSpan()` with automatic error recording and status management
- **Context propagation**: `injectTraceContext()` / `extractTraceContext()` for propagating trace IDs across RPC boundaries via token headers (`tid`/`sid` fields)
- **W3C Traceparent**: `formatTraceparent()` / `parseTraceparent()` for standard HTTP header interop
- **Log bridge**: `createOTelLogSink()` routes `@sozai/log` records to OTel LoggerProvider with severity mapping and span correlation
- **Trace-aware logging**: `traceLogger()` enriches a logger with active `traceID`/`spanID` properties
- **Semantic conventions**: Pre-defined `SpanNames` and `AttributeKeys` covering client, server, auth, transport, and streaming operations
- **Re-exports**: Common OTel types (`Span`, `Tracer`, `Context`, `SpanStatusCode`, `TraceFlags`) so consumers don't need `@opentelemetry/api` directly

**When to use:** Any service that needs distributed tracing, log correlation, or observability. Use this instead of writing custom OTel boilerplate -- it handles span lifecycle, error recording, and cross-service context propagation consistently.

---

## Additional Enkaku Packages

These packages are less commonly needed but available when relevant:

| Package | Purpose |
|---------|---------|
| `@sozai/async` | Async utilities: Disposer, defer, interruptions, lazy loading |
| `@sozai/result` | Result types for fallible operations (Ok/Error pattern) |
| `@sozai/patch` | JSON Patch operations (RFC 6902) |
| `@sozai/execution` | Execution chain management for middleware-like patterns |
| `@kokuin/capability` | Capability delegation chains, revocation backend and checker |
| `@sozai/flow` | Flow control and generator utilities |
| `@sozai/generator` | Generator utilities and patterns |
| `@enkaku/transport` | Base transport abstraction (used by protocol/client/server) |
| `@enkaku/standalone` | In-process client + server without a transport layer |
| `@enkaku/react` | React hooks for Enkaku RPC client |
| `@enkaku/electron` | Enkaku RPC over Electron IPC (main/preload/renderer) |

### Transport Implementations

When using the RPC framework, choose the appropriate transport:

| Transport | Package | Use Case |
|-----------|---------|----------|
| HTTP | `@enkaku/http-fetch`, `@enkaku/http-serve` | Standard HTTP APIs |
| WebSocket | `@enkaku/socket` | Real-time bidirectional communication |
| Node.js streams | `@enkaku/node-streams` | Inter-process communication |
| MessageChannel | `@enkaku/message` | In-process or worker communication |

### Hub & Group Communication

For multi-device messaging and E2EE group communication:

| Package | Purpose |
|---------|---------|
| `@kumiai/hub-protocol` | Protocol types for blind relay hub (send, group/send, receive) |
| `@kumiai/hub-server` | Hub server with `HubStore` abstraction, fan-out routing, ack-based delivery |
| `@kumiai/hub-client` | Hub client (send, groupSend, receive, group management) |
| `@kumiai/mls` | E2EE group management using MLS (RFC 9420) via ts-mls, noble CryptoProvider for Hermes |

### Keystore & Identity Implementations

For identity and key management, choose the appropriate keystore for the target environment:

| Environment | Package |
|-------------|---------|
| Node.js | `@kokuin/node` |
| Browser | `@kokuin/browser` |
| React Native / Expo | `@kokuin/expo` |
| Electron | `@kokuin/electron` |
| HD (software, any platform) | `@kokuin/deterministic` |
| Ledger hardware wallet | `@kokuin/ledger-device` |

`@kokuin/deterministic` derives Ed25519 keys from a BIP39 mnemonic via SLIP-0010. It implements both `KeyStore<Uint8Array>` and `IdentityProvider<FullIdentity>`.

`@kokuin/ledger-device` is a TypeScript client for a custom BOLOS app providing Ed25519 signing and X25519 ECDH. It implements `IdentityProvider<FullIdentity>`. Consumer provides the Ledger transport (`@ledgerhq/hw-transport-*`).
