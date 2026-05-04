import { Logger } from 'iii-sdk'

const logger = new Logger()

export default defineFunction({
  description: 'Send confirmation after order is processed',
  triggers: [
    { type: 'durable:subscriber', config: { topic: 'order.processed' } },
  ],
  handler: async (input: { orderId: string; total: number }) => {
    logger.info('Order confirmed', { orderId: input.orderId, total: input.total })
    const iii = useIii()
    await iii.trigger({ function_id: 'state::set', payload: { scope: 'orders', key: 'test', value: { status: 'notified', total: input.total } } })
    return { notified: true, orderId: input.orderId }
  },
})
