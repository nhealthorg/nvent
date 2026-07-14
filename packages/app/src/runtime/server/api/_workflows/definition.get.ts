import { defineEventHandler, getQuery, useIii } from '#imports'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const runId = query.run_id as string
  
  if (!runId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing run_id query parameter'
    })
  }

  const iii = useIii()

  // Fetch definition from state
  const def = await iii.trigger({ 
    function_id: 'state::get', 
    payload: { scope: 'workflow_def', key: runId } 
  }).catch(() => null)

  return def
})
