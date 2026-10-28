import { createError, defineEventHandler, readBody, useIii } from '#imports'

type CleanupBody = {
  older_than_days?: unknown
  execute?: unknown
}

export default defineEventHandler(async (event) => {
  const body = await readBody<CleanupBody>(event)
  const olderThanDays = body?.older_than_days
  if (!Number.isInteger(olderThanDays) || Number(olderThanDays) < 1 || Number(olderThanDays) > 3650) {
    throw createError({ statusCode: 400, statusMessage: 'older_than_days must be an integer between 1 and 3650.' })
  }
  if (body?.execute !== undefined && typeof body.execute !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'execute must be a boolean.' })
  }

  try {
    return await useIii().trigger({
      function_id: 'nworkflow::run-cleanup',
      payload: { older_than_days: olderThanDays, execute: body?.execute === true },
    })
  }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error('[cleanup.post] Workflow cleanup trigger failed:', error)
    throw createError({
      statusCode: 503,
      statusMessage: import.meta.dev
        ? `Workflow run cleanup is temporarily unavailable: ${detail}`
        : 'Workflow run cleanup is temporarily unavailable.',
    })
  }
})
