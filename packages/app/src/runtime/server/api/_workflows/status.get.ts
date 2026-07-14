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

  // Fetch status using the orchestrator's function
  const status = await iii.trigger({ 
    function_id: 'workflow::status', 
    payload: { run_id: runId } 
  })

  return status
})
