export default defineEventHandler(async event => {
  const runId = getRouterParam(event, 'runId')
  if (!runId) {
    throw createError({ statusCode: 400, statusMessage: 'runId is required' })
  }

  const response = await useIii().trigger({
    function_id: 'nworkflow::status',
    payload: {
      run_id: runId,
      include_result: true,
    },
  })

  return response && typeof response === 'object' && 'body' in response
    ? response.body
    : response
})