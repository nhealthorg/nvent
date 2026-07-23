import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'Aggregates branch B loop outputs',
  workflow: true,
  handler: async (input: any, ctx) => {
    const entries = Array.isArray(input) ? input : []
    const totalScore = entries.reduce((sum: number, entry: any) => sum + Number(entry?.score || 0), 0)
    const maxScore = entries.reduce((max: number, entry: any) => Math.max(max, Number(entry?.score || 0)), 0)

    ctx.logger?.debug('Summarizing branch B', { count: entries.length, totalScore })

    return {
      branch: 'B',
      count: entries.length,
      totalScore,
      maxScore,
    }
  },
})
