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
  handler: async (ctx, input: { text: string }) => {
    // Step 1: Process the text
    const processed = await ctx.node('process', {
      function: 'process-text',
      input: input
    })
    
    // Step 2: Analyze the processed text
    // This node depends on the 'process' node and will receive its output
    const analysis = await ctx.node('analyze', {
      function: 'analyze-text',
      input: processed  // This gets translated to { from: 'node:process' }
    })
    
    // Return the final analysis
    return analysis
  }
})
