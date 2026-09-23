import { defineFunction } from '#nvent/server'

type CohortInput = {
  patientId: string
}

export default defineFunction({
  description: 'Loads deterministic demo records for one cohort patient',
  workflow: true,
  handler: async (input: CohortInput) => {
    const patientId = input?.patientId || 'patient-001'
    const hasBaseline = patientId !== 'patient-missing-baseline'

    return {
      artifact_type: 'record_set',
      patient_id: patientId,
      records: [
        ...(hasBaseline ? [{ source: 'encounters', code: 'index-event', record_date: '2024-01-15', value: 'index' }] : []),
        { source: 'labs', code: 'albumin', record_date: '2024-01-20', value: 3.8 },
        { source: 'labs', code: 'albumin', record_date: '2024-02-10', value: 4.1 },
        { source: 'vitals', code: 'mobility', record_date: '2024-02-12', value: 72 },
      ],
      provenance: {
        step_id: 'load-records',
        source_refs: [`demo:${patientId}`],
      },
    }
  },
})
