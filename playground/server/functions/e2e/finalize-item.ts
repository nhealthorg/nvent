import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'E2E helper: validates loop.item field refs and var value forwarding',
  workflow: true,
  handler: async (input: { id?: string, label?: string, fromVar?: string }) => {
    return {
      itemId: input?.id,
      label: input?.label,
      fromVar: input?.fromVar,
      valid: Boolean(input?.id && input?.label && input?.fromVar),
    }
  },
})
