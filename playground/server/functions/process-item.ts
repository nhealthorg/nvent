import { defineFunction } from '#nvent/server'

/**
 * Process item in a foreach workflow node
 * 
 * Input: { text: string }
 * Output: { uppercase: string, lowercase: string, length: number }
 */
export default defineFunction({
  description: 'Processes text - converts to uppercase, lowercase, and counts length',
  workflow: true,
  request_format: {
    item: {
      type: 'string',
      description: 'The item to process',
      default: 'default-item'
    },
    text: {
      type: 'string',
      description: 'The text to process',
      default: 'Hello World'
    }
  },
  response_format: {
    item: {
      type: 'string',
      description: 'The processed item'
    },
    text: {
      type: 'string',
      description: 'The processed text'
    }
  },
  handler: async (input: { item: string, text: string }, ctx) => {
    const item = input?.item || ''
    const text = input?.text || ''

    ctx.logger?.debug('Processing item', { item, text })

    // wait for 5 seconds to simulate a long-running process
    await new Promise(resolve => setTimeout(resolve, 5000))
    
    return {
        item,
        text,
    }
  }
})
