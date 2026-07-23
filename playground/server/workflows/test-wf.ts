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
    const processed = await ctx.call('process-text', input)

    await ctx.all(c => [
      c.branch(async b => {
        const first = await b.call('process-item', processed)
        return b.call('process-item', first)
      }),
      c.branch(async b => {
        const third = await b.call('process-item', processed)
        return b.call('process-item', third)
      }),
    ] as const)

    const result = await ctx.call('analyze-text', input)

    return result
  }
})