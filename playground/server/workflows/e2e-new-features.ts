import { defineWorkflow } from '#nvent/server'

/**
 * E2E workflow for new workflow runtime features:
 * 1) Partial payload refs from previous node results
 * 2) Workflow variables via ctx.var(...)
 * 3) Passing var result to subsequent calls
 * 4) loop.item field refs inside loop calls
 */
export default defineWorkflow({
  name: 'e2e-new-features-workflow',
  description: 'End-to-end verification workflow for partial payload refs and ctx.var',
  request_format: {
    seed: {
      type: 'string',
      description: 'Seed value used for generated test data',
      default: 'hello-e2e',
    },
  },
  handler: async (input: { seed?: string }, ctx) => {
    const data1 = await ctx.call('e2e::get-values-1', input)
    const data2 = await ctx.call('e2e::get-values-2', input)

    // Partial object passing with property refs + nested refs.
    const partial = await ctx.call('e2e::validate-partial', {
      static: 'true',
      el: data1.wichtig,
      data: {
        data1,
        data2,
      },
    })

    // Persist a run-scoped workflow variable and reuse it in later steps.
    const testVar = await ctx.var('test', {
      active: true,
      resultValue: partial.el,
      combined: partial.data,
    })

    const consumed = await ctx.call('e2e::consume-var', testVar)
    const items = await ctx.call('e2e::make-items', { base: consumed.resultValue })

    const looped = await ctx.loop(items, async loop => {
      const loopItem = loop.item as any
      return loop.call('e2e::finalize-item', {
        id: loopItem.id,
        label: loopItem.text,
        fromVar: consumed.resultValue,
      })
    }, { mode: 'sequential' })

    return ctx.call('e2e::report', {
      partial,
      testVar,
      consumed,
      looped,
    })
  },
})
