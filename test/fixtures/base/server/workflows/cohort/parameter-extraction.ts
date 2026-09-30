import { defineWorkflow } from '#nvent/server'

export default defineWorkflow({
  name: 'cohort::parameter-extraction',
  description: 'Extracts one cohort parameter in a child workflow run',
  handler: async (input, ctx) => ctx.call('cohort::extract-parameter', input),
})
