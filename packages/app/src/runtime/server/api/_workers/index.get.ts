import { defineEventHandler, useIii } from '#imports'

/**
 * GET /api/_workers
 *
 * Combines the iii engine health check with the worker list so the
 * production Workers page can show both in a single request.
 */
export default defineEventHandler(async () => {
  const iii = useIii()

  const healthResult = await iii.trigger({ function_id: 'engine::health::check', payload: {} }).catch(e => ({ error: String(e) }))
  const workersResult = await iii.trigger({ function_id: 'engine::workers::list', payload: {} }).catch(e => ({ error: String(e) }))
  const functionsResult = await iii.trigger({ function_id: 'engine::functions::list', payload: {} }).catch(e => ({ error: String(e) }))

  const workersList = ((workersResult as any)?.workers ?? []) as any[]
  const functionsList = ((functionsResult as any)?.functions ?? []) as any[]


  // Map functions back to workers if the worker itself doesn't have them
  const mappedWorkers = workersList.map((w) => {
    const workerFunctions = [...(w.functions ?? [])]

    // If functions array is empty, try to find functions belonging to this worker
    if (workerFunctions.length === 0) {
      functionsList.forEach((f: any) => {
        const f_worker_id = f.worker_id || f.workerId
        const f_id = f.function_id || f.id || f.functionId

        if (f.worker_name === w.name || f_worker_id === w.id || f.worker_name === w.id) {
          workerFunctions.push(f_id)
        }
      })
    }

    return {
      ...w,
      functions: workerFunctions,
    }
  })

  return {
    health: (healthResult as any)?.error ? null : healthResult,
    healthError: (healthResult as any)?.error || null,
    workers: mappedWorkers,
    workersError: (workersResult as any)?.error || null,
  }
})
