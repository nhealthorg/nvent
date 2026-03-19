export default defineFunction({
  name: 'scheduled',
  description: 'Heartbeat that fires every minute',
  triggers: [
    { type: 'cron', config: { expression: '0 0 */2 * * * *' } },
  ],
  flows: ['system'],
  handler: async (_, ctx) => {
    ctx.logger.debug('Heartbeat', { tick: new Date().toISOString() })
    return { tick: new Date().toISOString() }
  },
})
