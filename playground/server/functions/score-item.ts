import { defineFunction } from '#nvent/server'

function scoreText(text: string): number {
  const vowelCount = (text.match(/[aeiou]/gi) || []).length
  return text.length + vowelCount * 2
}

export default defineFunction({
  description: 'Scores one transformed loop item in branch B',
  workflow: true,
  handler: async (input: any, ctx) => {
    const item = (input?.item || 'unknown-item').toString()
    const transformed = (input?.transformed || input?.text || '').toString()
    const score = scoreText(transformed)

    ctx.logger?.debug('Scoring branch B item', { item, score })

    return {
      item,
      transformed,
      score,
    }
  },
})
