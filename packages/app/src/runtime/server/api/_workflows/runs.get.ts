import { defineEventHandler, useIii } from '#imports'

export default defineEventHandler(async () => {
  const iii = useIii()

  // Fetch all runs from the engine state
  const runsResult = await iii.trigger({ 
    function_id: 'state::list', 
    payload: { scope: 'workflow_run' } 
  }).catch(() => ({ values: [] }))

  // Normalize response (state::list can return { values: [] } or just the array)
  const runs = Array.isArray(runsResult) ? runsResult : (runsResult as any)?.values || []

  return {
    runs: runs.sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0))
  }
})
