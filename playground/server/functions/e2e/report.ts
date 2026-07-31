import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'E2E helper: final report aggregator for quick workflow assertions',
  workflow: true,
  handler: async (input: any) => {
    const looped = Array.isArray(input?.looped) ? input.looped : []
    return {
      success: Boolean(input?.partial?.ok) && looped.every((item: any) => item?.valid),
      summary: {
        partialOk: Boolean(input?.partial?.ok),
        varAccepted: Boolean(input?.consumed?.accepted),
        loopCount: looped.length,
      },
      details: input,
    }
  },
})
