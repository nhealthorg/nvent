import { createError, defineEventHandler, getQuery, useIii } from '#imports'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const runId = query.run_id as string
  const nodeUid = query.node_uid as string

  if (!runId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing run_id query parameter',
    })
  }

  if (!nodeUid) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing node_uid query parameter',
    })
  }

  const iii = useIii()

  try {
    const response = await iii.trigger({
      function_id: 'nworkflow::node-result',
      payload: {
        run_id: runId,
        node_uid: nodeUid,
      },
    }) as { result?: unknown }

    return {
      node_uid: nodeUid,
      result: response?.result ?? null,
    }
  } catch (err) {
    console.error('[nvent/api] failed to fetch node result:', err)
    return {
      node_uid: nodeUid,
      result: null,
    }
  }
})
