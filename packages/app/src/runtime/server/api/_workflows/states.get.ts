import { createError, defineEventHandler, getQuery } from 'h3'

interface WorkflowStateItem {
  key: string
  value: unknown
}

export function normalizeStateItems(result: unknown): WorkflowStateItem[] {
  if (Array.isArray(result)) {
    return result
      .map((item: any, index: number) => ({
        key: String(item?.key || item?.id || item?.name || item?.state_key || `state-${index}`),
        value: item?.value ?? item?.data ?? item,
      }))
      .filter(item => Boolean(item.key))
  }

  if (result && typeof result === 'object') {
    const asRecord = result as Record<string, unknown>
    if (Array.isArray(asRecord.states)) {
      return normalizeStateItems(asRecord.states)
    }
    if (Array.isArray(asRecord.values)) {
      return normalizeStateItems(asRecord.values)
    }
    if (Array.isArray(asRecord.items)) {
      return normalizeStateItems(asRecord.items)
    }

    return Object.entries(asRecord).map(([key, value]) => ({
      key,
      value,
    }))
  }

  return []
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const runId = query.run_id as string
  const limit = query.limit ? parseInt(query.limit as string, 10) : 500

  if (!runId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing run_id query parameter',
    })
  }

  try {
    const result = await useIii().trigger({
      function_id: 'workflow::state-list',
      payload: {
        run_id: runId,
        limit,
      },
    })

    const states = normalizeStateItems(result)

    return { states }
  }
  catch (err) {
    console.error('[nvent/api] failed to fetch workflow states:', err)
    return { states: [] }
  }
})
