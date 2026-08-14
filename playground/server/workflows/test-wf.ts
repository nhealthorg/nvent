export default defineWorkflow({
  name: 'test-wf',
  description: 'A simple workflow that tests some parts of the workflow engine',
  inputPolicy: {
    returnType: 'store',
  },
  request_format: {
    text: {
      type: 'string',
      description: 'The text to process',
      default: 'Hello World'
    }
  },
  handler: async (input: { text: string }, ctx) => {
    const processed = await ctx.call('process-text', input)
    const items = await ctx.call('plan-items', processed)

    await ctx.all(c => [
      c.branch(async b => {
        const loopResult = await b.loop(items, async loopCtx => {
          const first = await loopCtx.call('process-item', loopCtx.item)
          return loopCtx.call('enrich-item', first)
        },{
          itemReturnType: 'store',
          mode: 'batch',
          batchSize: 4
        })
        return b.call('summarize-branch-a', loopResult)
      }),
      c.branch(async b => {
        const loopResult = await b.loop(items, async loopCtx => {
          const transformed = await loopCtx.call('transform-item', loopCtx.item)
          return loopCtx.call('score-item', transformed)
        }, { 
          mode: 'sequential'
        })
        return b.call('summarize-branch-b', loopResult)
      }),
    ] as const)

    const result = await ctx.call('analyze-text', {
      text: input.text
    }, {
      returnType: 'store',
      inputReturnType: 'store',
    })

    await ctx.call('test::end-test', { result })

    return result
  }
})