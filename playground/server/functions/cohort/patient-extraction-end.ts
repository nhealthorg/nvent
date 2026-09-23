import { defineFunction } from '#nvent/server'

type PatientExtractionEndInput = {
  event: 'on_end'
  run_id: string
  status: string
  workflow_name?: string
  updated_at: number
  result?: unknown
  result_error?: string | null
  pipeline: string
}

export default defineFunction({
  description: 'Records the successful completion of a cohort patient-extraction workflow run',
  workflow: true,
  handler: async (input: PatientExtractionEndInput, ctx) => {
    ctx.logger.info('[cohort hook] patient extraction completed', {
      runId: input.run_id,
      workflow: input.workflow_name,
      pipeline: input.pipeline,
      status: input.status,
    })

    return {
      acknowledged: true,
      event: input.event,
      run_id: input.run_id,
      pipeline: input.pipeline,
      status: input.status,
      recorded_at: Date.now(),
    }
  },
})
