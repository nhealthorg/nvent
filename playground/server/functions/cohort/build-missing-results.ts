import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'Creates a deterministic fallback when the cohort baseline is missing',
  workflow: true,
  handler: async (input: { baseline: any }) => ({
    status: 'skipped',
    reason: 'baseline_missing',
    baseline: input.baseline,
    results: [],
    provenance: {
      step_id: 'build-missing-results',
      source_refs: [],
    },
  }),
})
