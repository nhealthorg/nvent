import { Logger } from 'iii-sdk'

const logger = new Logger()

export default defineFunction({
  description: 'Returns a greeting message. Optionally takes a name as input.',
  triggers: [
    { type: 'http', config: { api_path: 'greet', http_method: 'GET', input: { name: 'string' } } },
  ],
  handler: async (req) => {
    const name = (req as any).query_params?.name ?? 'world'
    logger.info('greet called', { name })
    return {
      status: 200,
      body: {
        message: `Hello, ${name}!`,
        name,
      },
    }
  },
})
