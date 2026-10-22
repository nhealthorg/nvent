import { describe, expect, it, vi } from 'vitest'
import { defineWorkflow } from './defineWorkflow'

vi.mock('#imports', () => ({
  useRuntimeConfig: () => ({}),
}))
vi.mock('#nvent/iii-registry', () => ({ default: { functions: [] } }))

describe('defineWorkflow runtime agent options', () => {
  it('keeps model and provider as node references on native agent nodes in reduce bodies', async () => {
    const workflow = defineWorkflow({
      name: 'test::pipeline',
      handler: async (_input: unknown, ctx) => {
        const model = await ctx.call('resolve-model', {})
        const steps = await ctx.call('load-steps', {})
        return ctx.reduce(steps, {}, async (_accumulator, step, iteration) => {
          const prepared = await iteration.call('prepare-agent', { step })
          const result = await iteration.agent({
            prompt: 'Extract the requested value.',
            input: prepared,
            task: { title: 'extract' },
          }, {
            model: iteration.cond.prop(model, 'model'),
            provider: iteration.cond.prop(model, 'provider'),
          })
          return iteration.call('materialize-agent-result', { step, result })
        }, { mode: 'sequential' })
      },
    })

    const plan = await workflow.compile({})
    const entries = Object.entries(plan.nodes) as Array<[string, any]>
    const [reduceId, reduceNode] = entries.find(([, node]) => node.reduce)!
    const body = entries.filter(([, node]) => node.reduce_body?.reduce === reduceId)
    const agent = body.find(([, node]) => node.agent)![1]

    expect(reduceNode.reduce.body).toEqual(body.map(([nodeId]) => nodeId))
    expect(agent.agentOptions.model).toMatchObject({
      $ref: 'node:resolve-model', $path: ['model'], $source: 'node',
    })
    expect(agent.agentOptions.provider).toMatchObject({
      $ref: 'node:resolve-model', $path: ['provider'], $source: 'node',
    })
    expect(body.some(([, node]) => node.childWorkflow)).toBe(false)
  })
})