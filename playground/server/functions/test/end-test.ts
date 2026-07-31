export default defineFunction({
  description: 'Test',
  workflow: true,
  handler: async (input, context) => {
    context.workflow?.stream.send('progress', { message: 'Workflow is nearly ending' })
    context.logger?.debug('Waited at', { tick: new Date().toISOString() })
    await new Promise(resolve => setTimeout(resolve, 10000)) // wait for 10 seconds
    context.workflow?.stream.send('progress', { message: 'Workflow is ending' })
    return {}
  },
})