export default defineEventHandler(async () => {
  const response = await useIii().trigger({ function_id: 'nworkflow::sweep', payload: {} })
  return response && typeof response === 'object' && 'body' in response ? response.body : response
})
