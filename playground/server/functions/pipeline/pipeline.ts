export default defineFunction({
  name: 'pipeline::start',
  flows: ['pipeline'],
  triggers: [
    {
      type: 'http',
      config: { api_path: 'pipeline/start', http_method: 'POST' },
    },
  ],
  enqueues: ['pipeline.analyze'],
  handler: async (req, ctx) => {
    const text = (req.body as { text?: string })?.text ?? ''
    if (!text.trim()) {
      return { status: 400, body: { error: 'No text provided' } }
    }

    // The stream channel is identified by the flow name ('pipeline') and the
    // current trace ID — no need to create or pass a separate job ID.
    const { streamName, groupId } = ctx.stream.subscription()

    ctx.logger.info('Pipeline started', { streamName, groupId })

    // Enqueue the heavy analysis so the HTTP response returns immediately.
    // The trace ID is propagated through the queue message automatically,
    // so the Python step will write to the same stream channel.
    await ctx.enqueue({ topic: 'pipeline.analyze', data: { text } })

    return { status: 200, body: { streamName, groupId } }
  },
})

// Node.js steps that want to do immediate streaming work (not delegated to the queue)
// can still do so directly:
//
//   await ctx.stream.set('step-1', { step: 1, total: 4, label: 'Tokenizing text' })
//   await ctx.stream.send({ type: 'done' })

