export default defineFunction({
  description: 'Test',
  workflow: true,
  handler: async (input, context) => {
    await context.workflow?.stream.send('phase', {
      step: 'workflow-end',
      status: 'started',
    })
    await context.workflow?.stream.send('progress', { message: 'Workflow is nearly ending' })
    context.logger?.debug('Waited at', { tick: new Date().toISOString() })
    await new Promise(resolve => setTimeout(resolve, 10000)) // wait for 10 seconds

    const finalCount = Number((await context.workflow?.state.get('count')) ?? 0)

    await context.workflow?.stream.send('count', {
      message: 'Final workflow count',
      count: finalCount,
    })
    await context.workflow?.stream.send('progress', { message: 'Workflow is ending' })
    await context.workflow?.stream.send('phase', {
      step: 'workflow-end',
      status: 'completed',
      count: finalCount,
    })
    await context.workflow?.stream.send('summary', {
      finalCount,
      hasResult: Boolean(input?.result),
    })
    return {}
  },
})