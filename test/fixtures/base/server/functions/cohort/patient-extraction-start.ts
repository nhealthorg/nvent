import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'Acknowledges the start of a fixture workflow run',
  workflow: true,
  handler: async (input: any, ctx) => {
    ctx.logger.info('[fixture] patient extraction started', { runId: input.run_id, pipeline: input.pipeline })
    return { acknowledged: true, event: input.event, run_id: input.run_id, pipeline: input.pipeline, recorded_at: Date.now() }
  },
})
