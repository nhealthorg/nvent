import { Logger } from 'iii-sdk'

const logger = new Logger()

export default defineFunction({
  description: 'Process a placed order and notify downstream',
  triggers: [
    { type: 'durable:subscriber', config: { topic: 'order.placed' } },
    { type: 'http', config: { api_path: 'orders/:orderId/process', http_method: 'POST' } },
  ],
  handler: async (input: { orderId: string; total: number }) => {
    logger.info('Processing order', { orderId: input.orderId })
    const iii = useIii()
    await iii.trigger({ function_id: 'iii::durable::publish', payload: { topic: 'order.processed', data: { orderId: input.orderId, total: input.total } } })
    return { processed: true, orderId: input.orderId }
  },
})
