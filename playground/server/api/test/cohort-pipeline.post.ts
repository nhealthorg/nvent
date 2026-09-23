export default defineEventHandler(async event => {
  const input = await readBody<{ patientId?: string }>(event)
  const response = await useIii().trigger({
    function_id: 'cohort::patient-extraction',
    payload: {
      patientId: input?.patientId || 'patient-001',
    },
  })

  return response && typeof response === 'object' && 'body' in response
    ? response.body
    : response
})
