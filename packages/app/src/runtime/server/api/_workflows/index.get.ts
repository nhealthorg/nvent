import { defineEventHandler, useIii } from '#imports'
// @ts-ignore - auto-generated
import { registry } from '#nvent/iii-registry'

export default defineEventHandler(async () => {
  const iii = useIii()

  // 1. Get workflow definitions from registry
  const workflowDefinitions = registry?.workflows ?? []

  const [running, awaiting] = await Promise.all([
    iii.trigger({
      function_id: 'nworkflow::list-runs',
      payload: { status: 'running', limit: 100 },
    }).catch(() => ({ runs: [] })),
    iii.trigger({
      function_id: 'nworkflow::list-runs',
      payload: { status: 'awaiting_nodes', limit: 100 },
    }).catch(() => ({ runs: [] })),
  ])
  const runningRuns = (running as any)?.runs ?? []
  const awaitingRuns = (awaiting as any)?.runs ?? []
  const activeRuns = [...runningRuns, ...awaitingRuns]

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
