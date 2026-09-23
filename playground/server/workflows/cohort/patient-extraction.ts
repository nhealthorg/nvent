import { defineWorkflow } from '#nvent/server'

type PatientExtractionInput = {
  patientId: string
}

const PARAMETERS = [
  { id: 'albumin', code: 'albumin', output_type: 'continuous' },
  { id: 'mobility', code: 'mobility', output_type: 'continuous' },
]

/**
 * Test-only cohort pipeline:
 * load records -> resolve one shared baseline -> extract parameters -> snapshot.
 */
export default defineWorkflow({
  name: 'cohort::patient-extraction',
  description: 'Demo cohort extraction pipeline with shared baseline provenance',
  hooks: {
    onStart: {
      function: 'cohort::patient-extraction-start',
      input: { pipeline: 'patient-extraction' },
    },
    onEnd: {
      function: 'cohort::patient-extraction-end',
      input: { pipeline: 'patient-extraction' },
    },
  },
  handler: async (input: PatientExtractionInput, ctx) => {
    const records = await ctx.call('cohort::load-records', input)
    const baseline = await ctx.call('cohort::resolve-baseline', records)
    const parameters = await ctx.var('cohort_parameters', PARAMETERS)

    const results = await ctx.if(
      ctx.cond.eq(ctx.cond.prop(baseline, 'status'), 'ok'),
      async branch => {
        const extracted = await branch.loop(parameters, async loop => loop.callWorkflow('cohort::parameter-extraction', {
          parameter: loop.item,
          baseline,
          records: records.records,
        }, {
          label: 'Extract cohort parameter',
          result: { returnType: 'store' },
        }), { mode: 'sequential', itemReturnType: 'store' })

        return branch.reduce(extracted, [], async (_accumulator, _item, iteration) => iteration.call('cohort::append-result', {
          accumulator: iteration.accumulator,
          item: iteration.item,
        }), {
          mode: 'sequential',
          itemReturnType: 'store',
          accumulatorReturnType: 'store',
        })
      },
      branch => branch.call('cohort::build-missing-results', { baseline }),
    )

    return ctx.call('cohort::build-snapshot', {
      patientId: input.patientId,
      baseline,
      results,
    }, {
      returnType: 'store',
      inputReturnType: 'store',
    })
  },
})
