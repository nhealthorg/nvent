import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'E2E helper: consumes ctx.var output in a regular call',
  workflow: true,
  handler: async (input: any) => {
    return {
      accepted: Boolean(input?.active),
      resultValue: input?.resultValue,
      hasCombined: Boolean(input?.combined),
      source: 'consume-var',
    }
  },
})
