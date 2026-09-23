import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'Appends one child-workflow result to the canonical cohort accumulator',
  workflow: true,
  handler: async (input: { accumulator: any[], item: any }) => [
    ...input.accumulator,
    input.item,
  ],
})
