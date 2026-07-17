import { defineFunction } from '#nvent/server'

/**
 * Simple text processing function for workflow testing
 * 
 * Input: { text: string }
 * Output: { uppercase: string, lowercase: string, length: number }
 */
export default defineFunction({
  description: 'Processes text - converts to uppercase, lowercase, and counts length',
  workflow: true,
  handler: async (input: { text: string }, ctx) => {
    const text = input?.text || ''

    ctx.logger?.debug('Processing text', { text, bla: 'bla' })

    ctx.workflow?.state.set('lastProcessed', new Date().toISOString())
    let count = await ctx.workflow?.state.get('count') as number || 0
    ctx.workflow?.state.set('count', count+1)

    ctx.workflow?.stream.send('progress', { message: 'Processing started', text })

    // wait for 5 seconds to simulate a long-running process
    await new Promise(resolve => setTimeout(resolve, 5000))

    count = await ctx.workflow?.state.get('count') as number || 0
    ctx.workflow?.state.set('count', count+1)

    ctx.workflow?.stream.send('count', { message: 'Processing count', count })

    
    return {
      original: text,
      uppercase: text.toUpperCase(),
      lowercase: text.toLowerCase(),
      length: text.length,
      wordCount: text.split(/\s+/).filter(w => w.length > 0).length
    }
  }
})
