import type { Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@enkaku/client'
import type {
  ClientMessage,
  ClientTransportOf,
  ProtocolDefinition,
  ServerMessage,
} from '@enkaku/protocol'
import { connectSocket, SocketTransport } from '@enkaku/socket-transport'
import { getSocketPath } from '@tejika/env'

/** Reconnect backoff bounds: start fast, cap at a few seconds. */
const RECONNECT_BASE_MS = 250
const RECONNECT_MAX_MS = 5000

export type CreateDaemonClientOptions = {
  app: string
  socketPath?: string
}

/**
 * Connect an Enkaku `Client` to a running daemon, reconnecting automatically if
 * the daemon socket drops (e.g. the daemon is restarted after a rebuild). Throws
 * on the INITIAL connect if the socket is absent/refused, so `ensureDaemon` can
 * spawn the daemon; once connected, later drops are healed transparently.
 *
 * A clean peer close yields a done-read in the client, which fires no reconnect
 * hook — so the transport is forced to dispose when its socket closes, routing
 * every drop through `handleTransportDisposed`. A reconnect attempt that can't
 * reach the daemon surfaces as a read error instead, so both hooks share the
 * same reconnect path (exponential backoff, reset on a live connect).
 */
export async function createDaemonClient<Protocol extends ProtocolDefinition>(
  opts: CreateDaemonClientOptions,
): Promise<Client<Protocol>> {
  const socketPath = opts.socketPath ?? getSocketPath(opts.app)
  const firstSocket = await connectSocket(socketPath)

  let backoffMs = 0
  // Aborted on dispose: cancels an in-flight backoff and stops the next reconnect,
  // so shutdown never opens a fresh socket after teardown.
  const shutdown = new AbortController()

  // Build the first transport from an already-connected socket. The close
  // listener is bound to THIS transport: when its socket closes, disposing it
  // routes the drop through the client's handleTransportDisposed.
  // SocketTransport<R, W>: R = messages read FROM the socket, W = messages
  // written TO it. The client reads ServerMessage and writes ClientMessage, so
  // the daemon's server transport mirrors this as <ClientMessage, ServerMessage>.
  // The `as unknown as ClientTransportOf<Protocol>` cast below is required because
  // ClientTransportOf is a branded protocol type, not structurally a SocketTransport.
  const firstTransport = new SocketTransport<ServerMessage, ClientMessage>({ socket: firstSocket })
  firstSocket.once('close', () => void firstTransport.dispose())

  // A reconnecting transport: its lazy socket source waits out the backoff
  // (cancellable on shutdown), connects, resets the backoff, and binds the close
  // listener to this same transport instance.
  const reconnectingTransport = (): SocketTransport<ServerMessage, ClientMessage> => {
    let self: SocketTransport<ServerMessage, ClientMessage>
    const source = async (): Promise<Socket> => {
      if (backoffMs > 0) await delay(backoffMs, undefined, { signal: shutdown.signal })
      const socket = await connectSocket(socketPath)
      if (shutdown.signal.aborted) {
        socket.destroy()
        throw new Error('daemon client disposed')
      }
      backoffMs = 0
      socket.once('close', () => void self.dispose())
      return socket
    }
    self = new SocketTransport<ServerMessage, ClientMessage>({ socket: source })
    return self
  }

  // Both the disposed (clean close) and error (failed reconnect) paths reconnect.
  // During shutdown, return nothing so the client tears down instead.
  const nextTransport = (): ClientTransportOf<Protocol> | undefined => {
    if (shutdown.signal.aborted) return undefined
    backoffMs = backoffMs === 0 ? RECONNECT_BASE_MS : Math.min(backoffMs * 2, RECONNECT_MAX_MS)
    return reconnectingTransport() as unknown as ClientTransportOf<Protocol>
  }

  const client = new Client<Protocol>({
    transport: firstTransport as unknown as ClientTransportOf<Protocol>,
    handleTransportDisposed: nextTransport,
    handleTransportError: nextTransport,
  })
  // Stop reconnecting before the client aborts its transport on dispose, so
  // shutdown never opens a fresh socket after teardown.
  client.events.on('disposing', () => shutdown.abort())
  return client
}
