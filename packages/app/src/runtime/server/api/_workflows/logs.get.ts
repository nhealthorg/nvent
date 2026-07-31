import { useIii, defineEventHandler, getQuery, createError } from '#imports'

interface WorkflowRunLogRecord {
  id: string
  run_id: string
  node_uid?: string
  function_id?: string
  runtime?: string
  level: string
  message: string
  ts_unix_ms: number
  data?: Record<string, unknown>
}

function toUnixNano(ms: number | undefined): number {
  const value = Number(ms || 0)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value * 1_000_000)
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function parseStringList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined

  const parts = (Array.isArray(value) ? value : [value])
    .flatMap(entry => String(entry).split(','))
    .map(entry => entry.trim())
    .filter(Boolean)

  return parts.length > 0 ? parts : undefined
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const runId = query.run_id as string
  const nodeUids = parseStringList(query.node_uids as string | string[] | undefined)
  const limit = query.limit ? parseInt(query.limit as string) : 500

  if (!runId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing run_id query parameter'
    })
  }

  const iii = useIii()
  
  try {
    const response = await iii.trigger({
      function_id: 'workflow::log-read',
      payload: {
        run_id: runId,
        node_uids: nodeUids,
        limit
      }
    }) as { logs?: WorkflowRunLogRecord[] }

    return (response?.logs ?? [])
      .map((item) => {
        const data = asObject(item.data)
        return {
          timestamp_unix_nano: toUnixNano(item.ts_unix_ms),
          severity_text: String(item.level || 'info').toUpperCase(),
          body: item.message,
          service_name: 'nvent',
          trace_id: typeof data.trace_id === 'string' ? data.trace_id : undefined,
          span_id: typeof data.span_id === 'string' ? data.span_id : undefined,
          attributes: {
            ...(item.run_id ? { 'workflow.run_id': item.run_id } : {}),
            ...(item.node_uid ? { 'workflow.node_uid': item.node_uid } : {}),
            ...(item.function_id ? { 'iii.function.id': item.function_id } : {}),
            ...(item.runtime ? { 'workflow.runtime': item.runtime } : {}),
            'log.data': data,
          },
        }
      })
      .sort((a, b) => Number(b.timestamp_unix_nano || 0) - Number(a.timestamp_unix_nano || 0))
  } catch (err: any) {
    console.error('[nvent/api] failed to fetch workflow logs:', err)
    return []
  }
})
