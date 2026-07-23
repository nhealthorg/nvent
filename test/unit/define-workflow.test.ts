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
      async handler(input: { text: string, seconds: number }, ctx) {
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
      async handler(input: { text: string }, ctx) {
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
      async handler(input: { text: string }, ctx) {
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
      async handler(input: { text: string }, ctx) {
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
      async handler(input: { text: string[] }, ctx) {
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
      async handler(input: { text: string }, ctx) {
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
      async handler(input: { text: string }, ctx) {
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
      async handler(input: { text: string }, ctx) {
        await ctx.call('first-step', input)
        await ctx.all(() => [] as const)
        return ctx.call('final-step', input)
      },
    })

    const plan = await workflow.compile({ text: 'Hello' })

    expect(plan.nodes['first-step'].depends_on).toEqual([])
    expect(plan.nodes['final-step'].depends_on).toEqual(['first-step'])
  })

  it('supports sequential steps inside each parallel branch via ctx.branch', async () => {
    const workflow = defineWorkflow({
      name: 'parallel-branches-with-sequences',
      async handler(input: { text: string }, ctx) {
        await ctx.call('seed', input)

        await ctx.all(c => [
          c.branch(async b => {
            const a1 = await b.call('branch-a-step-1', input)
            return b.call('branch-a-step-2', a1)
          }),
          c.branch(async b => {
            const b1 = await b.call('branch-b-step-1', input)
            return b.call('branch-b-step-2', b1)
          }),
        ] as const)

        return ctx.call('join', input)
      },
    })

    const plan = await workflow.compile({ text: 'Hello' })

    expect(plan.nodes.seed.depends_on).toEqual([])

    expect(plan.nodes['branch-a-step-1'].depends_on).toEqual(['seed'])
    expect(plan.nodes['branch-a-step-2'].depends_on).toEqual(['branch-a-step-1'])

    expect(plan.nodes['branch-b-step-1'].depends_on).toEqual(['seed'])
    expect(plan.nodes['branch-b-step-2'].depends_on).toEqual(['branch-b-step-1'])

    expect(plan.nodes.join.depends_on).toEqual(['branch-a-step-2', 'branch-b-step-2'])
  })

  it('allows nested all inside a branch and still merges at branch tip', async () => {
    const workflow = defineWorkflow({
      name: 'nested-all-inside-branch',
      async handler(input: { text: string }, ctx) {
        await ctx.call('seed', input)

        await ctx.all(c => [
          c.branch(async b => {
            const first = await b.call('a1', input)
            await b.all(inner => [
              inner.call('a2_left', first),
              inner.call('a2_right', first),
            ] as const)
            return b.call('a3', input)
          }),
          c.branch(async b => {
            return b.call('b1', input)
          }),
        ] as const)

        return ctx.call('final', input)
      },
    })

    const plan = await workflow.compile({ text: 'Hello' })

    expect(plan.nodes.a1.depends_on).toEqual(['seed'])
    expect(plan.nodes.a2_left.depends_on).toEqual(['a1'])
    expect(plan.nodes.a2_right.depends_on).toEqual(['a1'])
    expect(plan.nodes.a3.depends_on).toEqual(['a2_left', 'a2_right'])
    expect(plan.nodes.b1.depends_on).toEqual(['seed'])
    expect(plan.nodes.final.depends_on).toEqual(['a3', 'b1'])
  })

  it('injects workflow queue from registry function metadata', async () => {
    registryMock.functions = [{
      id: 'queue-aware-fn',
      runtime: 'python',
      workflow: { queue: 'critical-workflows', engine_retry: { max_attempts: 4 } },
    }]

    const workflow = defineWorkflow({
      name: 'queue-propagation',
      async handler(input: { text: string }, ctx) {
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
      async handler(input: { text: string }, ctx) {
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
      async handler(input: { text: string }, ctx) {
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

  it('compiles loop with sequential per-item calls', async () => {
    const workflow = defineWorkflow({
      name: 'loop-sequential',
      async handler(input: { text: string }, ctx) {
        const items = await ctx.call('load-items', input)

        const processed = await ctx.loop(items, async loop => {
          const prepared = await loop.call('prepare-item', loop.item)
          return loop.call('process-item', prepared)
        }, { mode: 'sequential' })

        return ctx.call('finalize', processed)
      },
    })

    const plan = await workflow.compile({ text: 'Hello' })

    expect(plan.nodes['prepare-item'].fanout).toEqual({ over: 'node:load-items', mode: 'sequential' })
    expect(plan.nodes['prepare-item'].input).toEqual({ from: 'fanout_item' })
    expect(plan.nodes['prepare-item'].depends_on).toEqual(['load-items'])

    expect(plan.nodes['process-item'].fanout).toEqual({ over: 'node:load-items', mode: 'sequential' })
    expect(plan.nodes['process-item'].input).toEqual({ from: 'node:prepare-item' })
    expect(plan.nodes['process-item'].depends_on).toEqual(['prepare-item'])

    expect(plan.nodes['finalize'].depends_on).toEqual(['process-item'])
  })

  it('supports loops inside parallel all blocks', async () => {
    const workflow = defineWorkflow({
      name: 'loop-in-all',
      async handler(input: { text: string }, ctx) {
        const items = await ctx.call('load-items', input)

        await ctx.all(c => [
          c.loop(items, async loop => {
            const a = await loop.call('branch-a-item', loop.item)
            return loop.call('branch-a-item-final', a)
          }),
          c.call('audit', input),
        ] as const)

        return ctx.call('done', input)
      },
    })

    const plan = await workflow.compile({ text: 'Hello' })

    expect(plan.nodes['branch-a-item'].fanout).toEqual({ over: 'node:load-items' })
    expect(plan.nodes['branch-a-item-final'].fanout).toEqual({ over: 'node:load-items' })
    expect(plan.nodes['branch-a-item'].depends_on).toEqual(['load-items'])
    expect(plan.nodes['audit'].depends_on).toEqual(['load-items'])
    expect([...plan.nodes['done'].depends_on].sort()).toEqual(['audit', 'branch-a-item-final'])
  })

  it('allows returning an earlier result while executing later side-effect steps', async () => {
    const workflow = defineWorkflow({
      name: 'stale-output-node-regression',
      async handler(input: { text: string }, ctx) {
        const result = await ctx.node('process', {
          function: 'process-text',
          input: 'run_input',
        })

        await ctx.call('wait-error')
        return result
      },
    })

    const plan = await workflow.compile({ text: 'Hello' })

    expect(plan.output).toEqual({ from: 'process' })
    expect(plan.nodes.process.depends_on).toEqual([])
    expect(plan.nodes['wait-error'].depends_on).toEqual(['process'])
  })
})