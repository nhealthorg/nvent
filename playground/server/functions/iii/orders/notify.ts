export default defineFunction({
  id: 'orders::notify',
  description: 'Send confirmation after order is processed',
  triggers: [
    { type: 'queue', config: { topic: 'order.processed' } },
  ],
  flows: ['orders'],
  handler: async (input: { orderId: string; total: number }) => {
    logger.info('Order confirmed', { orderId: input.orderId, total: input.total })
    await stateManager.set('orders', 'test', { status: 'notified', total: input.total })
    // In a real app: send email, push notification, etc.
    return { notified: true, orderId: input.orderId }
  },
})
