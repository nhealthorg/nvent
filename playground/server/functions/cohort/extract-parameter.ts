import { defineFunction } from '#nvent/server'

type ParameterInput = {
  parameter: { id: string, code: string, output_type: string }
  baseline: { value: string | null }
  records: Array<{ code: string, value: number, record_date: string }>
}

export default defineFunction({
  description: 'Extracts and validates one parameter against the shared baseline',
  workflow: true,
  handler: async (input: ParameterInput) => {
    const candidates = input.records
      .filter(record => record.code === input.parameter.code)
      .sort((left, right) => left.record_date.localeCompare(right.record_date))
    const selected = candidates[0] ?? null

    return {
      artifact_type: 'extraction_result',
      target: input.parameter,
      status: selected ? 'ok' : 'missing',
      value: selected?.value ?? null,
      baseline: input.baseline,
      provenance: {
        step_id: `extract-${input.parameter.id}`,
        source_refs: selected ? [`record:${selected.code}:${selected.record_date}`] : [],
        selection: {
          candidates: candidates.map(candidate => candidate.record_date),
          selected: selected?.record_date ?? null,
        },
      },
    }
  },
})
