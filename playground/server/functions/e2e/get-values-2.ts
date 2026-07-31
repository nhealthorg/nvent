import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'E2E helper: returns base value set #2',
  workflow: true,
  handler: async (input: { seed?: string }) => {
    const seed = input?.seed || 'hello-e2e'
    return {
      other: `${seed}-other`,
      score: 42,
      source: 'values-2',
    }
  },
})
