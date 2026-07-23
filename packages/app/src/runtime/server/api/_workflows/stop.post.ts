import { defineEventHandler, readBody, useIii } from '#imports'

type StopBody = {
  run_id?: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<StopBody>(event)
  const runId = body?.run_id

  if (!runId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing run_id body parameter',
    })
  }

  const iii = useIii()
  const result = await iii.trigger({
    function_id: 'workflow::stop',
    payload: { run_id: runId },
  })

  return result
})
