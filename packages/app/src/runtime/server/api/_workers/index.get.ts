import { defineEventHandler, useIii } from '#imports'

/**
 * GET /api/_workers
 *
 * Combines the iii engine health check with the worker list so the
 * production Workers page can show both in a single request.
 */
export default defineEventHandler(async () => {
  const { iii } = useIii()

  const [health, workers] = await Promise.allSettled([
    iii.trigger({ function_id: 'engine::health::check', payload: {} }),
    iii.listWorkers(),
  ])

  return {
    health: health.status === 'fulfilled' ? health.value : null,
    healthError: health.status === 'rejected' ? String(health.reason) : null,
    workers: workers.status === 'fulfilled'
      ? (Array.isArray(workers.value) ? workers.value : [workers.value])
      : [],
    workersError: workers.status === 'rejected' ? String(workers.reason) : null,
  }
})
