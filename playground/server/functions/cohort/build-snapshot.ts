import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'Builds the demo cohort snapshot with shared baseline and results',
  workflow: true,
  handler: async (input: any) => ({
    status: input.results?.status === 'skipped' ? 'skipped' : 'completed',
    patient_id: input.patientId,
    baseline: input.baseline,
    results: input.results?.results ?? input.results,
    provenance: {
      pipeline_version: 1,
      steps: [
        'load-records',
        'resolve-baseline',
        'if-baseline-status',
        'parameter-extraction',
        'append-result',
        'build-snapshot',
      ],
    },
  }),
})
