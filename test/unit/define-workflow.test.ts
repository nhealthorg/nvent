import { beforeEach, describe, expect, it, vi } from 'vitest'

const registryMock: { functions: any[] } = { functions: [] }

vi.mock('#nvent/iii-registry', () => ({
  default: registryMock,
  registry: registryMock,
}), { virtual: true })

vi.mock('#imports', () => ({
  useIii: () => ({
    trigger: vi.fn(),
  }),
}), { virtual: true })

import { defineWorkflow } from '../../packages/nvent/src/runtime/nitro/utils/defineWorkflow'

describe('defineWorkflow compilation', () => {
  beforeEach(() => {
    registryMock.functions = []
  })

  it('keeps control-flow deps separate from older data refs after a parallel block', async () => {
    const workflow = defineWorkflow({
      name: 'multi-step',
      async handler(ctx, input: { text: string, seconds: number }) {
        const processed = await ctx.call('process-text', input)

        await ctx.all(c => [
          c.call('wait', input),
          c.call('process-text', { text: 'Parallel internal task' }),
        ] as const)

        return ctx.call('analyze-text', processed)
      },
    })

    const plan = await workflow.compile({ text: 'Hello', seconds: 5 })

    expect(plan.nodes['process-text'].depends_on).toEqual([])
    expect(plan.nodes.wait.depends_on).toEqual(['process-text'])
    expect(plan.nodes['process-text_1'].depends_on).toEqual(['process-text'])
    expect(plan.nodes['analyze-text'].depends_on).toEqual(['wait', 'process-text_1'])
    expect(plan.nodes['analyze-text'].input).toEqual({ from: 'node:process-text' })
  })

  it('restores a single sequential frontier after a parallel block', async () => {
    const workflow = defineWorkflow({
      name: 'sequential-after-parallel',
      async handler(ctx, input: { text: string }) {
        await ctx.call('first-step', input)

        await ctx.all(c => [
          c.call('parallel-a', input),
          c.call('parallel-b', input),
        ] as const)

        const joined = await ctx.call('join-step', input)
        return ctx.call('final-step', joined)
      },
    })

    const plan = await workflow.compile({ text: 'Hello' })

    expect(plan.nodes['first-step'].depends_on).toEqual([])
    expect(plan.nodes['parallel-a'].depends_on).toEqual(['first-step'])
    expect(plan.nodes['parallel-b'].depends_on).toEqual(['first-step'])
    expect(plan.nodes['join-step'].depends_on).toEqual(['parallel-a', 'parallel-b'])
    expect(plan.nodes['final-step'].depends_on).toEqual(['join-step'])
  })

  it('uses only the most recent parallel frontier for later steps', async () => {
    const workflow = defineWorkflow({
      name: 'multiple-parallel-blocks',
      async handler(ctx, input: { text: string }) {
        const original = await ctx.call('first-step', input)

        await ctx.all(c => [
          c.call('parallel-a', input),
          c.call('parallel-b', input),
        ] as const)

        await ctx.all(c => [
          c.call('parallel-c', input),
          c.call('parallel-d', input),
        ] as const)

        return ctx.call('final-step', original)
      },
    })

    const plan = await workflow.compile({ text: 'Hello' })

    expect(plan.nodes['parallel-c'].depends_on).toEqual(['parallel-a', 'parallel-b'])
    expect(plan.nodes['parallel-d'].depends_on).toEqual(['parallel-a', 'parallel-b'])
    expect(plan.nodes['final-step'].depends_on).toEqual(['parallel-c', 'parallel-d'])
    expect(plan.nodes['final-step'].input).toEqual({ from: 'node:first-step' })
  })

  it('merges nested parallel branches into the active frontier', async () => {
    const workflow = defineWorkflow({
      name: 'nested-parallel-blocks',
      async handler(ctx, input: { text: string }) {
        await ctx.call('seed-step', input)

        await ctx.all(c => [
          c.call('outer-a', input),
          c.all(inner => [
            inner.call('inner-a', input),
            inner.call('inner-b', input),
          ] as const),
        ] as const)

        return ctx.call('final-step', input)
      },
    })

    const plan = await workflow.compile({ text: 'Hello' })

    expect(plan.nodes['outer-a'].depends_on).toEqual(['seed-step'])
    expect(plan.nodes['inner-a'].depends_on).toEqual(['seed-step'])
    expect(plan.nodes['inner-b'].depends_on).toEqual(['seed-step'])
    expect(plan.nodes['final-step'].depends_on).toEqual(['outer-a', 'inner-a', 'inner-b'])
  })

  it('keeps foreach behind the latest parallel frontier while reading its fanout source', async () => {
    const workflow = defineWorkflow({
      name: 'foreach-after-parallel',
      async handler(ctx, input: { text: string[] }) {
        const items = await ctx.call('load-items', input)

        await ctx.all(c => [
          c.call('wait', input),
          c.call('prepare-batch', input),
        ] as const)

        return ctx.foreach('process-each', items, 'process-item')
      },
    })

    const plan = await workflow.compile({ text: ['a', 'b'] })

    expect(plan.nodes['wait'].depends_on).toEqual(['load-items'])
    expect(plan.nodes['prepare-batch'].depends_on).toEqual(['load-items'])
    expect(plan.nodes['process-each'].depends_on).toEqual(['wait', 'prepare-batch'])
    expect(plan.nodes['process-each'].fanout).toEqual({ over: 'node:load-items' })
    expect(plan.nodes['process-each'].input).toEqual({ from: 'fanout_item' })
  })

  it('merges explicit depends_on overrides with the active control frontier', async () => {
    const workflow = defineWorkflow({
      name: 'explicit-dep-override',
      async handler(ctx, input: { text: string }) {
        const first = await ctx.call('first-step', input)
        const second = await ctx.call('second-step', input)

        return ctx.node('custom-step', {
          function: 'custom-fn',
          input: first,
          depends_on: ['first-step', 'second-step'],
        })
      },
    })

    const plan = await workflow.compile({ text: 'Hello' })

    expect(plan.nodes['first-step'].depends_on).toEqual([])
    expect(plan.nodes['second-step'].depends_on).toEqual(['first-step'])
    expect(plan.nodes['custom-step'].depends_on).toEqual(['second-step'])
    expect(plan.nodes['custom-step'].input).toEqual({ from: 'node:first-step' })
  })

  it('keeps join inputs focused on the latest frontier after a parallel block', async () => {
    const workflow = defineWorkflow({
      name: 'join-after-parallel',
      async handler(ctx, input: { text: string }) {
        const seed = await ctx.call('seed-step', input)

        const [branchA, branchB] = await ctx.all(c => [
          c.call('branch-a', seed),
          c.call('branch-b', seed),
        ] as const)

        return ctx.call('merge-step', [branchA, branchB])
      },
    })

    const plan = await workflow.compile({ text: 'Hello' })

    expect(plan.nodes['branch-a'].depends_on).toEqual(['seed-step'])
    expect(plan.nodes['branch-b'].depends_on).toEqual(['seed-step'])
    expect(plan.nodes['merge-step'].depends_on).toEqual(['branch-a', 'branch-b'])
    expect(plan.nodes['merge-step'].input).toEqual({ from: ['node:branch-a', 'node:branch-b'] })
  })

  it('restores the previous frontier when a parallel block is empty', async () => {
    const workflow = defineWorkflow({
      name: 'empty-parallel-block',
      async handler(ctx, input: { text: string }) {
        await ctx.call('first-step', input)
        await ctx.all(() => [] as const)
        return ctx.call('final-step', input)
      },
    })

    const plan = await workflow.compile({ text: 'Hello' })

    expect(plan.nodes['first-step'].depends_on).toEqual([])
    expect(plan.nodes['final-step'].depends_on).toEqual(['first-step'])
  })

  it('injects workflow queue from registry function metadata', async () => {
    registryMock.functions = [{
      id: 'queue-aware-fn',
      runtime: 'python',
      workflow: { queue: 'critical-workflows', engine_retry: { max_attempts: 4 } },
    }]

    const workflow = defineWorkflow({
      name: 'queue-propagation',
      async handler(ctx, input: { text: string }) {
        return ctx.call('queue-aware-fn', input)
      },
    })

    const plan = await workflow.compile({ text: 'Hello' })

    expect(plan.nodes['queue-aware-fn'].function).toMatchObject({
      id: 'queue-aware-fn',
      runtime: 'python',
      queue: 'critical-workflows',
      engine_retry: { max_attempts: 4 },
    })
  })

  it('allows call-level retry override over registry workflow defaults', async () => {
    registryMock.functions = [{
      id: 'queue-aware-fn',
      runtime: 'python',
      workflow: { queue: 'critical-workflows', engine_retry: { max_attempts: 4 } },
    }]

    const workflow = defineWorkflow({
      name: 'retry-override',
      async handler(ctx, input: { text: string }) {
        return ctx.call('queue-aware-fn', input, {
          engine_retry: { max_attempts: 1 },
          queue: 'heartbeat',
        })
      },
    })

    const plan = await workflow.compile({ text: 'Hello' })

    expect(plan.nodes['queue-aware-fn'].function).toMatchObject({
      id: 'queue-aware-fn',
      runtime: 'python',
      queue: 'heartbeat',
      engine_retry: { max_attempts: 1 },
    })
  })

  it('allows node-level retry override over registry workflow defaults', async () => {
    registryMock.functions = [{
      id: 'queue-aware-fn',
      runtime: 'python',
      workflow: { queue: 'critical-workflows', engine_retry: { max_attempts: 4 } },
    }]

    const workflow = defineWorkflow({
      name: 'retry-node-override',
      async handler(ctx, input: { text: string }) {
        return ctx.node('custom-node', {
          function: 'queue-aware-fn',
          input,
          retry: { max_attempts: 2 },
        })
      },
    })

    const plan = await workflow.compile({ text: 'Hello' })

    expect(plan.nodes['custom-node'].function).toMatchObject({
      id: 'queue-aware-fn',
      runtime: 'python',
      queue: 'critical-workflows',
      engine_retry: { max_attempts: 2 },
    })
  })
})