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

    const result = await ctx.call('process-text', input)

    const itemCall1 = ctx.call('process-item', input)
    const itemCall2 = ctx.call('process-item', input)

    await ctx.all(() => [
      itemCall1,
      itemCall2
    ])

    return result
  }
})