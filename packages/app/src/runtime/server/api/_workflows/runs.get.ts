import { defineEventHandler, getQuery, useIii } from '#imports'

export default defineEventHandler(async (event) => {
  const iii = useIii()
  const query = getQuery(event)
  
  const statusFilter = query.status ? String(query.status) : undefined
  const workflowFilter = query.workflow ? String(query.workflow) : undefined
  const limit = parseInt(String(query.limit || '20'))
  const offset = parseInt(String(query.offset || '0'))

  // Fetch runs from the central workflow worker
  const result = await iii.trigger({ 
    function_id: 'workflow::list-runs', 
    payload: { 
      status: statusFilter,
      workflow: workflowFilter,
      limit,
      offset
    } 
  }).catch((err) => {
    console.error('[runs.get] Central listing failed, falling back to empty:', err)
    return { runs: [], pagination: { total: 0, limit, offset } }
  })

  return result
})
