export const pingProtocol = {
  ping: { type: 'request', result: { type: 'string' } },
} as const

export type PingProtocol = typeof pingProtocol
