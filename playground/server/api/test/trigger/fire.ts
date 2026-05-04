import { defineEventHandler, readBody, createError } from 'h3'
import { useIii } from '#imports'

/**
 * Test endpoint for manually invoking iii functions by ID.
 * POST /api/test/trigger/fire
 * Body: { functionId: string, input?: object }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const { functionId, input } = body

  if (!functionId) {
    throw createError({
      statusCode: 400,
      message: 'functionId is required',
    })
  }

  const iii = useIii()
  const result = await iii.trigger({ function_id: functionId, payload: input ?? {} })

  return {
    success: true,
    functionId,
    result,
  }
})
