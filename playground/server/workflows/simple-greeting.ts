import { defineWorkflow } from '#nvent/server'

/**
 * Simple text processing workflow - demonstrates the basics
 * 
 * Input: { text: string }
 * Output: { original, uppercase, lowercase, length, wordCount }
 * 
 * Example call:
 *   await iii.trigger({
 *     function_id: 'simple-text',
 *     payload: { text: 'Hello World' }
 *   })
 */
export default defineWorkflow({
  name: 'simple-text',
  description: 'A simple workflow that processes text',
  request_format: {
    text: {
      type: 'string',
      description: 'The text to process',
      default: 'Hello World'
    }
  },
  handler: async (ctx, input: { text: string }) => {
    // Single node that calls the process-text function
    const result = await ctx.node('process', {
      function: 'process-text',
      input: 'run_input'  // Pass workflow input directly to the function
    })
    
    return result
  }
})
