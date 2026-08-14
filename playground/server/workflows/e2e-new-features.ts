import { defineWorkflow } from '#nvent/server'

const LOOP_TEST_COUNT = 100
const LOOP_TEST_WAIT_MS = 2000
const LOOP_TEST_MODE: 'parallel' | 'sequential' | 'batch' = 'parallel'
const LOOP_TEST_BATCH_SIZE = 25

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
    loopCount: {
      type: 'number',
      description: 'Number of loop items for stress tests',
      default: LOOP_TEST_COUNT,
    },
    waitMs: {
      type: 'number',
      description: 'Per-item artificial wait in milliseconds',
      default: LOOP_TEST_WAIT_MS,
    },
  },
  handler: async (input: { seed?: string, loopCount?: number, waitMs?: number }, ctx) => {
    const loopCount = Number.isFinite(Number(input?.loopCount)) && Number(input?.loopCount) > 0
      ? Math.floor(Number(input.loopCount))
      : LOOP_TEST_COUNT
    const waitMs = Number.isFinite(Number(input?.waitMs)) && Number(input?.waitMs) >= 0
      ? Math.floor(Number(input.waitMs))
      : LOOP_TEST_WAIT_MS

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
    const items = await ctx.call('e2e::make-items', {
      base: consumed.resultValue,
      count: loopCount,
    })

    const loopTestConfig = await ctx.var('loop_test', {
      count: loopCount,
      waitMs,
      mode: LOOP_TEST_MODE,
      batchSize: LOOP_TEST_BATCH_SIZE,
    })

    const loopOptions: {
      mode: 'parallel' | 'sequential' | 'batch'
      batchSize?: number
    } = {
      mode: LOOP_TEST_MODE,
    }
    if (loopOptions.mode === 'batch') {
      loopOptions.batchSize = LOOP_TEST_BATCH_SIZE
    }

    const looped = await ctx.loop(items, async loop => {
      const loopItem = loop.item as any
      await loop.call('e2e::wait-item', {
        waitMs: loopTestConfig.waitMs,
        itemId: loopItem.id,
      })
      return loop.call('e2e::finalize-item', {
        id: loopItem.id,
        label: loopItem.text,
        fromVar: consumed.resultValue,
      })
    }, loopOptions)

    return ctx.call('e2e::report', {
      partial,
      testVar,
      consumed,
      loopTestConfig,
      looped,
    })
  },
})
