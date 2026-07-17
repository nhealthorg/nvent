import { useIii } from '#imports'
import { createError, defineEventHandler, getQuery } from 'h3'

function asArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (Array.isArray(obj.values)) {
      return obj.values.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
    }
    if (Array.isArray(obj.items)) {
      return obj.items.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
    }
    return Object.entries(obj).map(([key, item]) => {
      if (item && typeof item === 'object' && 'key' in (item as Record<string, unknown>)) {
        return item as Record<string, unknown>
      }
      return { key, value: item }
    })
  }

  return []
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const runId = query.run_id as string
  const nodeUid = query.node_uid as string | undefined
  const limit = query.limit ? Number.parseInt(String(query.limit), 10) : 500

  if (!runId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing run_id query parameter',
    })
  }

  const iii = useIii()

  try {
    const raw = await iii.trigger({
      function_id: 'state::list',
      payload: { 
        scope: 'workflow_run_state',
        key: `${runId}/*`
      },
    })

    console.log('[nvent/api] workflow states raw:', raw)

    const prefix = `${runId}/`
    const records = asArray(raw)
      .map((item) => {
        const key = String(item.key || '')
        const value = (item.value && typeof item.value === 'object' ? item.value : item) as Record<string, unknown>
        return {
          id: String(value.id || key || ''),
          run_id: String(value.run_id || ''),
          node_uid: value.node_uid ? String(value.node_uid) : undefined,
          function_id: value.function_id ? String(value.function_id) : undefined,
          kind: String(value.kind || 'set'),
          key: value.key ? String(value.key) : (key.startsWith(prefix) ? key.slice(prefix.length) : key),
          value: value.value,
          ts_unix_ms: Number(value.ts_unix_ms || 0),
        }
      })
      .filter((item) => item.run_id === runId || String(item.id).startsWith(prefix))
      .filter((item) => !nodeUid || item.node_uid === nodeUid)
      .sort((a, b) => Number(b.ts_unix_ms || 0) - Number(a.ts_unix_ms || 0))
      .slice(0, Math.max(1, Math.min(limit, 2_000)))

    return { states: records }
  }
  catch (err) {
    console.error('[nvent/api] failed to fetch workflow states:', err)
    return { states: [] }
  }
})
