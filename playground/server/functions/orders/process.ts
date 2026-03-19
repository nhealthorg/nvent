export default defineFunction({
  name: 'orders::process',
  description: 'Process a placed order and notify downstream',
  triggers: [
    { type: 'queue', config: { topic: 'order.placed' } },
    { type: 'http', config: { api_path: 'orders/:orderId/process', http_method: 'POST' } },
  ],
  enqueues: ['order.processed'],
  flows: ['orders'],
  handler: async (input: { orderId: string; total: number }) => {
    logger.info('Processing order', { orderId: input.orderId })
    // In a real app: persist order, run business logic, etc.
    await enqueue({ topic: 'order.processed', data: { orderId: input.orderId, total: input.total } })
    return { processed: true, orderId: input.orderId }
  },
})
