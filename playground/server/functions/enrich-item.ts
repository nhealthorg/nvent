import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'Enriches one loop item in branch A',
  workflow: true,
  handler: async (input: any, ctx) => {
    const item = (input?.item || 'unknown-item').toString()
    const text = (input?.text || '').toString()

    ctx.logger?.debug('Enriching branch A item', { item })

    return {
      item,
      text,
      enrichedText: `${text} [enriched:${item}]`,
      textLength: text.length,
    }
  },
})
