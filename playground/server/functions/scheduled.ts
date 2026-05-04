import { Logger } from 'iii-sdk'

const logger = new Logger()

export default defineFunction({
  description: 'Heartbeat that fires every minute',
  triggers: [
    { type: 'cron', config: { expression: '0 0 */2 * * * *' } },
  ],
  handler: async () => {
    logger.debug('Heartbeat', { tick: new Date().toISOString() })
    return { tick: new Date().toISOString() }
  },
})
