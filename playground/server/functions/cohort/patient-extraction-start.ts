import { defineFunction } from '#nvent/server'

type PatientExtractionStartInput = {
  event: 'on_start'
  run_id: string
  status: string
  workflow_name?: string
  created_at: number
  pipeline: string
}

export default defineFunction({
  description: 'Records the start of a cohort patient-extraction workflow run',
  workflow: true,
  handler: async (input: PatientExtractionStartInput, ctx) => {
    ctx.logger.info('[cohort hook] patient extraction started', {
      runId: input.run_id,
      workflow: input.workflow_name,
      pipeline: input.pipeline,
    })

    return {
      acknowledged: true,
      event: input.event,
      run_id: input.run_id,
      pipeline: input.pipeline,
      recorded_at: Date.now(),
    }
  },
})
