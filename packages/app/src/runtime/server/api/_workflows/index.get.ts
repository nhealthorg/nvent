import { defineEventHandler, useIii } from '#imports'
// @ts-ignore - auto-generated
import { registry } from '#nvent/iii-registry'

export default defineEventHandler(async () => {
  const iii = useIii()

  // 1. Get workflow definitions from registry
  const workflowDefinitions = registry?.workflows ?? []

  // 2. Fetch live status if engine is available
  // We use state::list to get all runs and filter for active ones
  const runsResult = await iii.trigger({ 
    function_id: 'state::list', 
    payload: { scope: 'workflow_run' } 
  }).catch(() => ({ values: [] }))

  const runs = Array.isArray(runsResult) ? runsResult : (runsResult as any)?.values || []
  const activeRuns = runs.filter((r: any) => r.status === 'running' || r.status === 'pending')

  return {
    definitions: workflowDefinitions.map((w: any) => ({
      id: w.id,
      description: w.description,
      triggers: w.triggers,
      filePath: w.filePath,
      request_format: w.request_format,
      response_format: w.response_format
    })),
    active_runs: activeRuns
  }
})
