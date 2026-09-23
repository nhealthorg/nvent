import { defineFunction } from '#nvent/server'

type RecordSet = {
  patient_id: string
  records: Array<{ code: string, record_date: string }>
}

export default defineFunction({
  description: 'Resolves the first index event as the shared patient baseline',
  workflow: true,
  handler: async (input: RecordSet) => {
    const record = input.records.find(item => item.code === 'index-event')

    return {
      artifact_type: 'validated_value',
      target: { kind: 'baseline', id: 'cohort-baseline', output_type: 'date' },
      value: record?.record_date ?? null,
      status: record ? 'ok' : 'missing',
      provenance: {
        step_id: 'resolve-baseline',
        source_refs: [`patient:${input.patient_id}`, 'record:index-event'],
      },
    }
  },
})
