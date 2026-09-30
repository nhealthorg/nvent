import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'Appends one child-workflow result to the fixture accumulator',
  workflow: true,
  handler: async (input: { accumulator: any[], item: any }) => [...input.accumulator, input.item],
})
