import { defineEventHandler, readBody, useIii } from '#imports'

type DeleteBody = {
  run_id?: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<DeleteBody>(event)
  const runId = body?.run_id

  if (!runId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing run_id body parameter',
    })
  }

  const iii = useIii()
  const result = await iii.trigger({
    function_id: 'workflow::run-delete',
    payload: { run_id: runId },
  })

  return result
})
