import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'Acknowledges completion of a fixture workflow run',
  workflow: true,
  handler: async (input: any, ctx) => {
    ctx.logger.info('[fixture] patient extraction completed', { runId: input.run_id, pipeline: input.pipeline, status: input.status })
    return { acknowledged: true, event: input.event, run_id: input.run_id, pipeline: input.pipeline, status: input.status, recorded_at: Date.now() }
  },
})
