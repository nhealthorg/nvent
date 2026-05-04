import { Logger  } from '#nvent/server'

const logger = new Logger()

export default defineFunction({
  description: 'Start the text analysis pipeline',
  triggers: [
    { type: 'http', config: { api_path: 'pipeline/start', http_method: 'POST' } },
  ],
  handler: async (req) => {
    // Accept both HTTP trigger (req.body.text) and direct browser SDK trigger (req.text)
    const body: { text?: string } = (req as any).body ?? req
    const text = body.text ?? ''
    if (!text.trim()) {
      return { status: 400, body: { error: 'No text provided' } }
    }

    // Create a stream group for this job
    const groupId = globalThis.crypto.randomUUID()
    const streamName = 'pipeline'

    logger.info('Pipeline started', { streamName, groupId })

    // Enqueue the heavy analysis
    const iii = useIii()
    await iii.trigger({
      function_id: 'iii::durable::publish',
      payload: { topic: 'pipeline.analyze', data: { text, streamName, groupId } },
    })

    return { status: 200, body: { streamName, groupId } }
  },
})
