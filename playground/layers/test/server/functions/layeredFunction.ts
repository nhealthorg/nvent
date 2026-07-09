import { Logger } from '#nvent/server'

const logger: Logger = new Logger()

export default defineFunction({
  description: 'Returns a greeting message. Optionally takes a name as input.',
  triggers: [
    { type: 'http', config: { api_path: 'greet/layered', http_method: 'GET', input: { name: 'string' } } },
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
