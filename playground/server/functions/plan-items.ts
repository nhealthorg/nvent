import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'Builds loop items from processed text for workflow loop tests',
  workflow: true,
  handler: async (input: any, ctx) => {
    const baseText = (input?.original || input?.text || '').toString().trim()
    const words = baseText
      .split(/\s+/)
      .map((w: string) => w.trim())
      .filter((w: string) => w.length > 0)

    const source = words.length > 0 ? words : [baseText || 'default-item']
    const limited = source.slice(0, 6)

    ctx.logger?.debug('Planning workflow loop items', { count: limited.length })

    return limited.map((text: string, index: number) => ({
      item: `item-${index + 1}`,
      text,
      index,
    }))
  },
})
