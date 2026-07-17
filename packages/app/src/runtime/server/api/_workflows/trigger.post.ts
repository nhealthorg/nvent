import { defineEventHandler, readBody, useIii } from '#imports'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const { workflowId, input } = body
  
  if (!workflowId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing workflowId'
    })
  }

  const iii = useIii()

  // We trigger the workflow function directly.
  // The defineWorkflow logic handles wrapping this into workflow::start
  const result = await iii.trigger({ 
    function_id: workflowId, 
    payload: input || {} 
  })

  const resultRecord = (result && typeof result === 'object') ? (result as any) : null
  const runId = resultRecord ? resultRecord.run_id : undefined
  const response: any = runId
    ? {
        stream: {
          streamName: 'workflow',
          groupId: runId,
        },
      }
    : {
        stream: undefined,
      }

  if (resultRecord) {
    for (const [key, value] of Object.entries(resultRecord)) {
      response[key] = value
    }
  }

  return response
})
