import { describe, expect, it, vi } from 'vitest'
import { guardDevWebSocketUpgrade } from '../../packages/nvent/src/iii/dev-upgrade'

describe('dev WebSocket upgrade guard', () => {
  it.each(['ECONNRESET', 'EPIPE'])('contains browser disconnects (%s)', async code => {
    const upgrade = vi.fn().mockRejectedValue(Object.assign(new Error('socket closed'), { code }))
    const server = { upgrade }
    guardDevWebSocketUpgrade(server)

    const result = server.upgrade()
    await expect(result).resolves.toBeUndefined()
    expect(upgrade).toHaveBeenCalledOnce()
  })

  it('handles a rejected upgrade when the caller ignores its promise', async () => {
    const upgrade = vi.fn().mockRejectedValue(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    const server = { upgrade }
    guardDevWebSocketUpgrade(server)

    void server.upgrade()
    await vi.waitFor(() => expect(upgrade).toHaveBeenCalledOnce())
  })

  it('logs unexpected failures and does not wrap twice', async () => {
    const error = new Error('upgrade failed')
    const upgrade = vi.fn().mockRejectedValue(error)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = { upgrade }
    try {
      guardDevWebSocketUpgrade(server)
      const guardedUpgrade = server.upgrade
      guardDevWebSocketUpgrade(server)
      expect(server.upgrade).toBe(guardedUpgrade)

      await expect(server.upgrade()).resolves.toBeUndefined()
      expect(log).toHaveBeenCalledWith('[nvent] dev WebSocket upgrade failed:', error)
    }
    finally {
      log.mockRestore()
    }
  })
})