import { createError, defineEventHandler, getQuery, useIii } from '#imports'

interface WorkflowStreamMessage {
  id: string
  item_id?: string
  run_id?: string
  node_uid?: string
  function_id?: string
  ts_unix_ms?: number
  data?: unknown
}

interface WorkflowStreamGroup {
  streamName: string
  items: WorkflowStreamMessage[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return undefined
  return n
}

function timestampFromWorkflowItemId(value: unknown): number | undefined {
  const id = String(value || '')
  const match = /^st_(\d+)_/.exec(id)
  if (!match) return undefined
  return asFiniteNumber(match[1])
}

function resolveTimestampMs(item: any, keyHint?: string): number {
  const dataRecord = asRecord(item?.data) ?? asRecord(item?.value) ?? asRecord(item)

  const directCandidates = [
    item?.ts_unix_ms,
    item?.timestamp_unix_ms,
    item?.timestamp_ms,
    item?.ts,
    item?.created_at,
  ]

  for (const candidate of directCandidates) {
    const parsed = asFiniteNumber(candidate)
    if (parsed && parsed > 0) return parsed
  }

  if (dataRecord) {
    const nestedCandidates = [
      dataRecord.ts_unix_ms,
      dataRecord.timestamp_unix_ms,
      dataRecord.timestamp_ms,
      dataRecord.ts,
      dataRecord.created_at,
    ]
    for (const candidate of nestedCandidates) {
      const parsed = asFiniteNumber(candidate)
      if (parsed && parsed > 0) return parsed
    }
  }

  const idCandidates = [item?.item_id, item?.id, keyHint]
  for (const candidate of idCandidates) {
    const parsed = timestampFromWorkflowItemId(candidate)
    if (parsed && parsed > 0) return parsed
  }

  return 0
}

function normalizeStreamItems(result: unknown): WorkflowStreamMessage[] {
  if (Array.isArray(result)) {
    return result.map((item: any, index: number) => ({
      id: String(item?.id || item?.item_id || `item-${index}`),
      item_id: item?.item_id || item?.id || undefined,
      run_id: item?.run_id || undefined,
      node_uid: item?.node_uid || undefined,
      function_id: item?.function_id || undefined,
      ts_unix_ms: resolveTimestampMs(item),
      data: item?.data ?? item,
    }))
  }

  if (result && typeof result === 'object') {
    const asRecord = result as Record<string, unknown>
    const values = Array.isArray(asRecord.values)
      ? asRecord.values
      : Array.isArray(asRecord.items)
        ? asRecord.items
        : Object.entries(asRecord).map(([key, value]) => ({ key, value }))

    return values.map((item: any, index: number) => ({
      id: String(item?.id || item?.item_id || item?.key || `item-${index}`),
      item_id: item?.item_id || item?.id || item?.key || undefined,
      run_id: item?.run_id || undefined,
      node_uid: item?.node_uid || undefined,
      function_id: item?.function_id || undefined,
      ts_unix_ms: resolveTimestampMs(item, item?.key),
      data: item?.value ?? item?.data ?? item,
    }))
  }

  return []
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const runId = query.run_id as string

  if (!runId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing run_id query parameter',
    })
  }

  try {
    const iii = useIii()

    const result = await iii.trigger({
      function_id: 'nworkflow::stream-list',
      payload: {
        run_id: runId,
      },
    })

    const rawStreams: unknown = (result as any)?.streams
    const streamNameList: string[] = []
    if (Array.isArray(rawStreams)) {
      for (const item of rawStreams) {
        if (typeof item === 'string') streamNameList.push(item)
      }
    }
    else if (Array.isArray(result)) {
      for (const item of result) {
        if (typeof item === 'string') streamNameList.push(item)
      }
    }

    const streams: WorkflowStreamGroup[] = await Promise.all(
      streamNameList.map(async (streamName) => {
        const streamResult = await iii.trigger({
          function_id: 'stream::list',
          payload: {
            stream_name: streamName,
            group_id: runId,
          },
        })

        return {
          streamName,
          items: normalizeStreamItems(streamResult).sort((left, right) => (right.ts_unix_ms || 0) - (left.ts_unix_ms || 0)),
        }
      }),
    )
      .then(result => result.filter(group => group.items.length > 0 || group.streamName))
      .then(result => result.sort((left, right) => {
        const leftTs = left.items[0]?.ts_unix_ms || 0
        const rightTs = right.items[0]?.ts_unix_ms || 0
        return rightTs - leftTs
      }))

    return { streams }
  }
  catch (err) {
    console.error('[nvent/api] failed to fetch workflow streams:', err)
    return { streams: [] }
  }
})
