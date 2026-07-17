import { useIii } from '#imports'
import { createError, defineEventHandler, getQuery } from 'h3'

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

interface WorkflowRunTraceRecord {
  id: string
  run_id: string
  node_uid?: string
  function_id?: string
  runtime?: string
  event_name: string
  ts_unix_ms: number
  attributes?: Record<string, unknown>
  trace_id?: string
  span_id?: string
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

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const runId = query.run_id as string
  const nodeUid = query.node_uid as string | undefined
  const limit = query.limit ? parseInt(query.limit as string, 10) : 500

  if (!runId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing run_id query parameter',
    })
  }

  const iii = useIii()

  try {
    const [traceResult, logResult] = await Promise.all([
      iii.trigger({
        function_id: 'workflow::trace-read',
        payload: {
          run_id: runId,
          node_uid: nodeUid,
          limit,
        },
      }) as Promise<{ traces?: WorkflowRunTraceRecord[] }>,
      iii.trigger({
        function_id: 'workflow::log-read',
        payload: {
          run_id: runId,
          node_uid: nodeUid,
          limit,
        },
      }) as Promise<{ logs?: WorkflowRunLogRecord[] }>,
    ])

    const traces = traceResult?.traces ?? []
    const logs = logResult?.logs ?? []

    const spans = traces.map((item, idx) => {
      const attributes = {
        ...asObject(item.attributes),
        ...(item.run_id ? { 'workflow.run_id': item.run_id } : {}),
        ...(item.node_uid ? { 'workflow.node_uid': item.node_uid } : {}),
        ...(item.function_id ? { 'iii.function.id': item.function_id } : {}),
        ...(item.runtime ? { 'workflow.runtime': item.runtime } : {}),
      }
      const tsUnixNano = toUnixNano(item.ts_unix_ms)
      const traceId = item.trace_id || `${runId}-${idx}`
      const spanId = item.span_id || item.id || `span-${idx}`

      return {
        trace_id: traceId,
        span_id: spanId,
        name: item.event_name,
        status: item.event_name.endsWith('failed') ? 'error' : 'ok',
        pending: false,
        start_time_unix_nano: tsUnixNano,
        end_time_unix_nano: tsUnixNano,
        attributes,
        events: [
          {
            name: item.event_name,
            timestamp_unix_nano: tsUnixNano,
            attributes,
          },
        ],
      }
    })

    const mappedLogs = logs
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

    const traceIds = Array.from(new Set(spans.map((span) => span.trace_id).filter(Boolean)))

    return { trace_ids: traceIds, spans, logs: mappedLogs }
  } catch (err: any) {
    console.error('[nvent/api] failed to fetch workflow timeline:', err)
    return { trace_ids: [], spans: [], logs: [] }
  }
})