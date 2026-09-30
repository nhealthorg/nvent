export default defineEventHandler(async event => {
  const body = await readBody<{ run_id?: string, node_uid?: string, attempt?: number, result?: unknown }>(event)
  if (!body?.run_id || !body.node_uid) {
    throw createError({ statusCode: 400, statusMessage: 'run_id and node_uid are required' })
  }
  const payload = {
    run_id: body.run_id,
    node_uid: body.node_uid,
    attempt: body.attempt ?? 0,
    function_id: 'workflow-resilience-test',
    runtime: 'e2e',
    result: body.result ?? { replayed: true },
  }
  const first = await useIii().trigger({ function_id: 'nworkflow::node-completed', payload })
  const second = await useIii().trigger({ function_id: 'nworkflow::node-completed', payload })
  return {
    first: first && typeof first === 'object' && 'body' in first ? first.body : first,
    second: second && typeof second === 'object' && 'body' in second ? second.body : second,
  }
})
