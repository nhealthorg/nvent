import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'E2E helper: returns base value set #1',
  workflow: true,
  handler: async (input: { seed?: string }) => {
    const seed = input?.seed || 'hello-e2e'
    return {
      wichtig: `${seed}-important`,
      source: 'values-1',
      nested: {
        from: 'get-values-1',
        seed,
      },
    }
  },
})
