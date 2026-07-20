import { createError, defineEventHandler, getQuery } from 'h3'

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

function normalizeStreamItems(result: unknown): WorkflowStreamMessage[] {
  if (Array.isArray(result)) {
    return result.map((item: any, index: number) => ({
      id: String(item?.id || item?.item_id || `item-${index}`),
      item_id: item?.item_id || item?.id || undefined,
      run_id: item?.run_id || undefined,
      node_uid: item?.node_uid || undefined,
      function_id: item?.function_id || undefined,
      ts_unix_ms: Number(item?.ts_unix_ms || item?.ts || 0),
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
      ts_unix_ms: Number(item?.ts_unix_ms || item?.ts || 0),
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
      function_id: 'workflow::stream-list',
      payload: {
        run_id: runId,
      },
    })

    const streamNames = Array.isArray((result as { streams?: string[] })?.streams)
      ? (result as { streams?: string[] }).streams
      : Array.isArray(result)
        ? result.filter((item): item is string => typeof item === 'string')
        : []

    const streams: WorkflowStreamGroup[] = await Promise.all(
      streamNames.map(async (streamName) => {
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
