import { createError, defineEventHandler, getQuery, useIii } from '#imports'

type TimelineMode = 'traces' | 'logs' | 'states' | 'streams'

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

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function parseLoopIndex(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseStringList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined

  const parts = (Array.isArray(value) ? value : [value])
    .flatMap(entry => String(entry).split(','))
    .map(entry => entry.trim())
    .filter(Boolean)

  return parts.length > 0 ? parts : undefined
}

function nodeHasLoopIndex(nodeUid: string | undefined, loopIndex: number | undefined): boolean {
  if (loopIndex === undefined) return true
  if (!nodeUid) return false
  const match = /#(\d+)$/.exec(nodeUid)
  if (!match) return false
  return Number.parseInt(match[1] || '', 10) === loopIndex
}

function matchesLoopFilter(item: { node_uid?: string, function_id?: string }, loopIndex: number | undefined): boolean {
  if (loopIndex === undefined) return true
  return nodeHasLoopIndex(item.node_uid, loopIndex) || nodeHasLoopIndex(item.function_id, loopIndex)
}

function mapTraceEventType(eventName: string): string {
  if (eventName === 'workflow.node.started') return 'step.started'
  if (eventName === 'workflow.node.completed') return 'step.completed'
  if (eventName === 'workflow.node.failed') return 'step.failed'
  if (eventName === 'workflow.state.set') return 'state.set'
  if (eventName === 'workflow.state.delete') return 'state.delete'
  if (eventName === 'workflow.stream.publish' || eventName === 'workflow.stream.set') return 'stream.publish'
  if (eventName === 'workflow.stream.delete') return 'stream.delete'
  return eventName || 'trace.event'
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const runId = query.run_id as string
  const nodeUids = parseStringList(query.node_uids as string | string[] | undefined)
  const type = (query.type as TimelineMode | undefined) || 'traces'
  const limit = query.limit ? Number.parseInt(query.limit as string, 10) : 20
  const offset = query.offset ? Number.parseInt(query.offset as string, 10) : 0
  const loopIndex = parseLoopIndex(query.loop_index as string | undefined)

  if (!runId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing run_id query parameter',
    })
  }

  const iii = useIii()

  try {
    if (type === 'traces') {
      const traceResult = await iii.trigger({
        function_id: 'workflow::trace-read',
        payload: {
          run_id: runId,
          node_uids: nodeUids,
          limit,
          offset,
          loop_index: loopIndex,
        },
      }) as { traces?: WorkflowRunTraceRecord[], has_more?: boolean, next_offset?: number }

      const records = (traceResult?.traces ?? []).filter(item => matchesLoopFilter(item, loopIndex))
      const mapped = records.map((item, index) => ({
        id: item.id || `${runId}-trace-${offset + index}`,
        ts: Number(item.ts_unix_ms || 0),
        type: mapTraceEventType(String(item.event_name || 'trace.event')),
        stepName: String(item.node_uid || item.function_id || ''),
        data: {
          eventName: item.event_name,
          traceId: item.trace_id,
          spanId: item.span_id,
          attributes: asObject(item.attributes),
          runId: item.run_id,
          nodeUid: item.node_uid,
          functionId: item.function_id,
          runtime: item.runtime,
        },
      }))

      return {
        type,
        items: mapped,
        has_more: Boolean(traceResult?.has_more),
        next_offset: Number(traceResult?.next_offset || offset + mapped.length),
      }
    }

    if (type === 'logs') {
      const logResult = await iii.trigger({
        function_id: 'workflow::log-read',
        payload: {
          run_id: runId,
          node_uids: nodeUids,
          limit,
          offset,
          loop_index: loopIndex,
        },
      }) as { logs?: WorkflowRunLogRecord[], has_more?: boolean, next_offset?: number }

      const records = (logResult?.logs ?? []).filter(item => matchesLoopFilter(item, loopIndex))
      const mapped = records.map((item, index) => {
        const data = asObject(item.data)
        const level = String(item.level || data.level || 'info').toLowerCase()
        const message = String(item.message || data.message || '')

        return {
          id: item.id || `${runId}-log-${offset + index}`,
          ts: Number(item.ts_unix_ms || 0),
          type: 'log',
          stepName: String(item.node_uid || item.function_id || ''),
          level,
          message,
          data: {
            level,
            message,
            traceId: data.trace_id,
            spanId: data.span_id,
            runId: item.run_id,
            nodeUid: item.node_uid,
            functionId: item.function_id,
            runtime: item.runtime,
            metadata: data,
          },
        }
      })

      return {
        type,
        items: mapped,
        has_more: Boolean(logResult?.has_more),
        next_offset: Number(logResult?.next_offset || offset + mapped.length),
      }
    }

    if (type === 'states') {
      const traceResult = await iii.trigger({
        function_id: 'workflow::trace-read',
        payload: {
          run_id: runId,
          node_uids: nodeUids,
          loop_index: loopIndex,
          event_name_prefix: 'workflow.state.',
          limit,
          offset,
        },
      }) as {
        traces?: WorkflowRunTraceRecord[]
        has_more?: boolean
        next_offset?: number
      }

      const stateItems = Array.isArray(traceResult?.traces) ? traceResult.traces : []

      return {
        type,
        items: stateItems.map((item, index) => ({
          id: item.id || `${runId}-state-${offset + index}`,
          ts: Number(item.ts_unix_ms || 0),
          type: mapTraceEventType(String(item.event_name || 'workflow.state.set')),
          stepName: String(item.node_uid || item.function_id || ''),
          data: {
            eventName: item.event_name,
            key: asObject(item.attributes)['workflow.state.key'],
            value: asObject(item.attributes)['workflow.state.value'],
            attributes: asObject(item.attributes),
            runId: item.run_id,
            nodeUid: item.node_uid,
            functionId: item.function_id,
          },
        })),
        has_more: Boolean(traceResult?.has_more),
        next_offset: Number(traceResult?.next_offset || (offset + stateItems.length)),
      }
    }

    const traceResult = await iii.trigger({
      function_id: 'workflow::trace-read',
      payload: {
        run_id: runId,
        node_uids: nodeUids,
        loop_index: loopIndex,
        event_name_prefix: 'workflow.stream.',
        limit,
        offset,
      },
    }) as {
      traces?: WorkflowRunTraceRecord[]
      has_more?: boolean
      next_offset?: number
    }

    const streamItems = Array.isArray(traceResult?.traces) ? traceResult.traces : []

    return {
      type: 'streams',
      items: streamItems.map((item, index) => ({
        id: item.id || `${runId}-stream-${offset + index}`,
        ts: Number(item.ts_unix_ms || 0),
        type: mapTraceEventType(String(item.event_name || 'workflow.stream.publish')),
        stepName: String(item.node_uid || item.function_id || ''),
        data: {
          eventName: item.event_name,
          streamName: asObject(item.attributes)['workflow.stream.name'],
          runId: item.run_id,
          itemId: asObject(item.attributes)['workflow.stream.item_id'],
          nodeUid: item.node_uid,
          functionId: item.function_id,
          preview: asObject(item.attributes)['workflow.stream.preview'],
          payload: asObject(item.attributes)['workflow.stream.payload'],
          attributes: asObject(item.attributes),
        },
      })),
      has_more: Boolean(traceResult?.has_more),
      next_offset: Number(traceResult?.next_offset || (offset + streamItems.length)),
    }
  }
  catch (err) {
    console.error('[nvent/api] failed to fetch workflow traces:', err)
    return {
      type,
      items: [],
      has_more: false,
      next_offset: 0,
    }
  }
})
