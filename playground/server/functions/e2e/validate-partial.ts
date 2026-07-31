import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'E2E helper: validates partial payload composition from previous nodes',
  workflow: true,
  handler: async (input: any) => {
    const el = input?.el
    const data1 = input?.data?.data1
    const data2 = input?.data?.data2

    return {
      ok: Boolean(input?.static === 'true' && typeof el === 'string' && data1 && data2),
      static: input?.static,
      el,
      data: {
        data1,
        data2,
      },
      checks: {
        hasData1: Boolean(data1),
        hasData2: Boolean(data2),
      },
    }
  },
})
