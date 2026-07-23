import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'Transforms one loop item in branch B',
  workflow: true,
  handler: async (input: any, ctx) => {
    const item = (input?.item || 'unknown-item').toString()
    const text = (input?.text || '').toString()

    ctx.logger?.debug('Transforming branch B item', { item })

    // wait  500ms to simulate a slow transformation
    await new Promise(resolve => setTimeout(resolve, 5000))

    return {
      item,
      text,
      transformed: text.toUpperCase(),
      reversed: text.split('').reverse().join(''),
    }
  },
})
