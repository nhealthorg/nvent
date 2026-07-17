import { defineWorkflow } from '#nvent/server'

/**
 * Multi-step workflow - demonstrates sequential node execution
 * 
 * This workflow:
 * 1. Processes the input text (uppercase, lowercase, counts)
 * 2. Analyzes the processed result (gets detailed statistics)
 * 
 * Input: { text: string }
 * Output: Analysis results with statistics
 * 
 * Example call:
 *   await iii.trigger({
 *     function_id: 'multi-step',
 *     payload: { text: 'The quick brown fox jumps over the lazy dog' }
 *   })
 */
export default defineWorkflow({
  name: 'multi-step',
  description: 'Multi-step text processing and analysis workflow',
  request_format: {
    text: {
      type: 'string',
      description: 'The text to process',
      default: 'Hello World'
    },
    seconds: {
      type: 'number',
      description: 'Number of seconds to wait',
      default: 5
    }
  },
  handler: async (ctx, input: { 
    text: string,
    seconds: number
   }) => {
    // Step 1: Process the text
    const processed = await ctx.call('process-text', input)

    // Parallel wait and extra task - use function wrapper to enable parallel scope
    await ctx.all(c => [
      c.call('wait', input),
      c.call('process-text', { text: 'Parallel internal task' })
    ])

    await ctx.call('wait-error')
    
    // Step 2: Analyze the processed text
    // This node depends on the 'process' node and will receive its output
    const analysis = await ctx.call('analyze-text', processed)
    
    // Return the final analysis
    return analysis
  }
})
