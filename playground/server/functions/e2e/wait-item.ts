import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'E2E helper: waits for a configurable duration per loop item',
  workflow: true,
  handler: async (input: { waitMs?: number, itemId?: string }) => {
    const waitMsRaw = Number(input?.waitMs)
    const waitMs = Number.isFinite(waitMsRaw) && waitMsRaw >= 0
      ? Math.min(60_000, Math.floor(waitMsRaw))
      : 2000

    await new Promise(resolve => setTimeout(resolve, waitMs))

    return {
      waitedMs: waitMs,
      itemId: input?.itemId || null,
    }
  },
})
