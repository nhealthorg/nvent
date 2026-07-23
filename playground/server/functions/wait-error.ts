export default defineFunction({
  description: 'Heartbeat that fires every minute',
  workflow: true,
  handler: async (input, context) => {
    context.logger?.debug('Waited at', { tick: new Date().toISOString() })
    await new Promise(resolve => setTimeout(resolve, 10000)) // wait for 10 seconds

    return {}
  },
})