import { createError, defineEventHandler, getQuery, useIii } from '#imports'

export default defineEventHandler(async (event) => {
  const iii = useIii()
  const query = getQuery(event)
  
  const statusFilter = query.status ? String(query.status) : undefined
  const workflowFilter = query.workflow ? String(query.workflow) : undefined
  const workflowIdFilter = query.workflow_id ? String(query.workflow_id) : undefined
  const limit = parseInt(String(query.limit || '20'))
  const offset = parseInt(String(query.offset || '0'))
  const cursor = query.cursor ? String(query.cursor) : undefined

  // Fetch runs from the central workflow worker
  const result = await iii.trigger({ 
    function_id: 'nworkflow::list-runs', 
    payload: { 
      status: statusFilter,
      workflow_id: workflowIdFilter,
      workflow: workflowFilter,
      limit,
      offset,
      cursor
    } 
  }).catch((err: unknown) => {
    console.error('[runs.get] Central listing failed:', err)
    throw createError({ statusCode: 503, statusMessage: 'Workflow run listing is temporarily unavailable' })
  })

  return result
})
