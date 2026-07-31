import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'E2E helper: creates loop items for loop.item path testing',
  workflow: true,
  handler: async (input: { base?: string }) => {
    const base = input?.base || 'loop-base'
    return [
      { id: 'item-1', text: `${base}-A` },
      { id: 'item-2', text: `${base}-B` },
      { id: 'item-3', text: `${base}-C` },
    ]
  },
})
