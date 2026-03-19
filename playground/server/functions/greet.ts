export default defineFunction({
  name: 'greet',
  description: 'Returns a greeting message. Optionally takes a name as input.',
  triggers: [
    { type: 'http', config: { api_path: 'greet', http_method: 'GET', input: { name: 'string' } } }
  ],
  flows: ['api'],
  handler: async (req, ctx) => {
    const name = req.query_params?.name ?? 'world'
    await ctx.state.set('lastGreeted', name)
    ctx.logger.info('greet called', { name })
    return { 
      status: 200,
      body: { 
        message: `Hello, ${name}!`,
        name,
      } 
    }
  },
})
