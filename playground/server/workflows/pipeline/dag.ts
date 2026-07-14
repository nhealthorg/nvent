import { defineWorkflow } from '#nvent/server'

/**
 * Pipeline DAG workflow - calls Python analyze function
 * 
 * This workflow demonstrates calling a Python function from a workflow.
 * 
 * Input: { text: string }
 * Output: { wordCount, charCount, uniqueWords, avgWordLength, longestWord, uniqueWordsList }
 * 
 * Example call:
 *   await iii.trigger({
 *     function_id: 'pipeline::dag',
 *     payload: {
 *       text: 'The quick brown fox jumps over the lazy dog'
 *     }
 *   })
 */
export default defineWorkflow({
  name: 'pipeline::dag',
  description: 'Text analysis pipeline using Python function',
  handler: async (ctx, payload: { text: string }) => {
    // Node 1: Call the Python analyze function
    // The function expects: { text }
    // We use 'run_input' to pass the workflow input directly to the function
    const analyze = await ctx.node('analyze', {
      function: 'pipeline::analyze',  // Python function in pipeline/ directory
      input: payload  // Pass the entire workflow input to the function
    })

    // Return the analysis result
    return analyze
  }
})
