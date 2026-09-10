import { createError, defineEventHandler, getQuery, useIii } from '#imports'

interface VarItem {
  key: string
  version: number
  updated_at: number
  value: unknown
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const runId = query.run_id as string
  const key = query.key as string | undefined

  if (!runId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing run_id query parameter',
    })
  }

  const iii = useIii()

  try {
    const result = await iii.trigger({
      function_id: 'nworkflow::var-list',
      payload: {
        run_id: runId,
        key,
      },
    }) as { items?: VarItem[] }

    const items = Array.isArray(result?.items) ? result.items : []

    return {
      items,
      count: items.length,
    }
  }
  catch (err) {
    console.error('[nvent/api] failed to fetch workflow vars:', err)
    return {
      items: [],
      count: 0,
    }
  }
})
