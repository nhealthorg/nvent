import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'E2E helper: creates loop items for loop.item path testing',
  workflow: true,
  handler: async (input: { base?: string, count?: number }) => {
    const base = input?.base || 'loop-base'
    const requestedCount = Number(input?.count)
    const count = Number.isFinite(requestedCount) && requestedCount > 0
      ? Math.min(10_000, Math.floor(requestedCount))
      : 3

    return Array.from({ length: count }, (_, idx) => {
      const itemNo = idx + 1
      return {
        id: `item-${itemNo}`,
        text: `${base}-${itemNo}`,
      }
    })
  },
})
