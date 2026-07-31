import { defineFunction } from '#nvent/server'

/**
 * Simple text processing function for workflow testing
 * 
 * Input: { text: string }
 * Output: { uppercase: string, lowercase: string, length: number }
 */
export default defineFunction({
  label: 'Process Text',
  description: 'Processes text - converts to uppercase, lowercase, and counts length',
  workflow: true,
  handler: async (input: { text: string }, ctx) => {
    const text = input?.text || ''

    ctx.logger?.debug('Processing text', { text, bla: 'bla' })

    await ctx.workflow?.state.set('lastProcessed', new Date().toISOString())

    const initialCount = Number((await ctx.workflow?.state.get('count')) ?? 0)
    const startedCount = initialCount + 1
    await ctx.workflow?.state.set('count', startedCount)

    await ctx.workflow?.stream.send('phase', {
      step: 'process-text',
      status: 'started',
      count: startedCount,
    })
    await ctx.workflow?.stream.send('progress', {
      message: 'Processing started',
      text,
      count: startedCount,
    })

    // wait for 5 seconds to simulate a long-running process
    await new Promise(resolve => setTimeout(resolve, 5000))

    const beforeFinishCount = Number((await ctx.workflow?.state.get('count')) ?? startedCount)
    const finishedCount = beforeFinishCount + 1
    await ctx.workflow?.state.set('count', finishedCount)

    await ctx.workflow?.stream.send('count', {
      message: 'Processing count updated',
      count: finishedCount,
    })
    await ctx.workflow?.stream.send('phase', {
      step: 'process-text',
      status: 'completed',
      count: finishedCount,
    })

    
    return {
      original: text,
      uppercase: text.toUpperCase(),
      lowercase: text.toLowerCase(),
      length: text.length,
      wordCount: text.split(/\s+/).filter(w => w.length > 0).length
    }
  }
})
