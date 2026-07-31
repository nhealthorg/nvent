import { defineEventHandler, readBody, useIii } from '#imports'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isFunctionNotFoundError(err: unknown): boolean {
  const e = err as { code?: unknown, message?: unknown }
  if (e?.code === 'function_not_found') return true
  const msg = typeof e?.message === 'string' ? e.message : String(err)
  return /function_not_found|function\s+.+\s+not\s+found/i.test(msg)
}

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const { workflowId, input } = body
  
  if (!workflowId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing workflowId'
    })
  }

  const iii = useIii()

  // We trigger the workflow function directly.
  // The defineWorkflow logic handles wrapping this into workflow::start
  let result: unknown
  const maxAttempts = 8
  let lastErr: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      result = await iii.trigger({
        function_id: workflowId,
        payload: input || {},
      })
      lastErr = undefined
      break
    } catch (err) {
      lastErr = err
      if (!isFunctionNotFoundError(err) || attempt === maxAttempts) {
        throw err
      }

      const delayMs = Math.min(150 * Math.pow(1.5, attempt - 1), 1200)
      console.warn(`[nvent/workflow] trigger retry ${attempt}/${maxAttempts} for '${workflowId}' after function_not_found (${Math.round(delayMs)}ms)`)
      await sleep(delayMs)
    }
  }

  if (lastErr) throw lastErr

  const resultRecord = (result && typeof result === 'object') ? (result as any) : null
  const runId = resultRecord ? resultRecord.run_id : undefined
  const response: any = runId
    ? {
        stream: {
          streamName: 'workflow',
          groupId: runId,
        },
      }
    : {
        stream: undefined,
      }

  if (resultRecord) {
    for (const [key, value] of Object.entries(resultRecord)) {
      response[key] = value
    }
  }

  return response
})
