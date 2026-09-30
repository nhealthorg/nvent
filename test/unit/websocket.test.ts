import { describe, expect, it, vi } from 'vitest'
import { closeWebSocketPeer, normalizeWebSocketCloseCode } from '../../packages/nvent/src/runtime/nitro/utils/websocket'

describe('WebSocket proxy close handling', () => {
  it('maps abnormal upstream close code 1006 to a sendable server error', () => {
    expect(normalizeWebSocketCloseCode(1006)).toBe(1011)
  })

  it('preserves valid close codes', () => {
    expect(normalizeWebSocketCloseCode(1000)).toBe(1000)
    expect(normalizeWebSocketCloseCode(1008)).toBe(1008)
  })

  it('does not throw when the peer closes during forwarding', () => {
    const close = vi.fn(() => {
      throw new Error('peer already closed')
    })

    expect(() => closeWebSocketPeer({ close }, 1006, 'abnormal closure')).not.toThrow()
    expect(close).toHaveBeenCalledWith(1011, 'abnormal closure')
  })
})