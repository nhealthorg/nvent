const SENDABLE_CLOSE_CODES = new Set([
  1000,
  1001,
  1002,
  1003,
  1007,
  1008,
  1009,
  1010,
  1011,
  1012,
  1013,
  1014,
])

export function normalizeWebSocketCloseCode(code: unknown, fallback = 1011): number {
  const numericCode = typeof code === 'number' ? code : Number(code)
  return Number.isInteger(numericCode) && SENDABLE_CLOSE_CODES.has(numericCode)
    ? numericCode
    : fallback
}

export function closeWebSocketPeer(peer: { close: (code: number, reason?: string) => void }, code: unknown, reason: unknown): void {
  try {
    peer.close(normalizeWebSocketCloseCode(code), typeof reason === 'string' ? reason : undefined)
  }
  catch {
    // The peer may have closed between the upstream event and this call.
  }
}