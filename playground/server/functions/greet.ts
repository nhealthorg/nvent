import { Logger } from '#nvent/server'

const logger: Logger = new Logger()

export default defineFunction({
  description: 'Returns a greeting message. Optionally takes a name as input.',
  triggers: [
    { type: 'http', config: { api_path: 'greet', http_method: 'GET', input: { name: 'string' } } },
  ],
  handler: async (req) => {
    const name = (req as any).query_params?.name ?? 'world'
    const iii = useIii()
    const {
      old_value: previousName,
    } = await iii.trigger({ function_id: 'state::set', payload: { scope: 'greet', key: 'lastGreeted1', value: name } })
    logger.info('greet called', { name, previousName, bla: 'bla' })
    return {
      status: 200,
      body: {
        message: `Hello, ${name}! Last greeted: ${previousName ?? 'none'}`,
        name,
      },
    }
  },
})
