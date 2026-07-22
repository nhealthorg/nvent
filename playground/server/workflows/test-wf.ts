export default defineWorkflow({
  name: 'test-wf',
  description: 'A simple workflow that tests some parts of the workflow engine',
  request_format: {
    text: {
      type: 'string',
      description: 'The text to process',
      default: 'Hello World'
    }
  },
  handler: async (input: { text: string }, ctx) => {

    const result = await ctx.call('process-text-2', input)

    await ctx.call('process-item', input)
    await ctx.call('process-item', input)

    return result
  }
})