import { defineFunction } from '#nvent/server'

/**
 * Simple text processing function for workflow testing
 * 
 * Input: { text: string }
 * Output: { uppercase: string, lowercase: string, length: number }
 */
export default defineFunction({
  description: 'Processes text - converts to uppercase, lowercase, and counts length',
  handler: async (input: { text: string }) => {
    const text = input?.text || ''

    // wait for 5 seconds to simulate a long-running process
    await new Promise(resolve => setTimeout(resolve, 5000))
    
    return {
      original: text,
      uppercase: text.toUpperCase(),
      lowercase: text.toLowerCase(),
      length: text.length,
      wordCount: text.split(/\s+/).filter(w => w.length > 0).length
    }
  }
})
