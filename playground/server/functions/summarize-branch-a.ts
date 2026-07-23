import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'Aggregates branch A loop outputs',
  workflow: true,
  handler: async (input: any, ctx) => {
    const entries = Array.isArray(input) ? input : []
    const firstThree = entries.slice(0, 3).map((entry: any) => entry?.enrichedText || entry?.text || '')

    ctx.logger?.debug('Summarizing branch A', { count: entries.length })

    return {
      branch: 'A',
      count: entries.length,
      preview: firstThree,
    }
  },
})
