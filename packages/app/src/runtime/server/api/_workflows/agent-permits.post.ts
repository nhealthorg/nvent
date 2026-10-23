import { createError, defineEventHandler, readBody, useIii } from '#imports'
import { requireAgentPermitAdmin } from '../../utils/agentPermitAdmin'

export default defineEventHandler(async event => {
  const actor = requireAgentPermitAdmin(event, true)
  const body = await readBody<{ owner?: unknown, action?: unknown, confirmation?: unknown, reason?: unknown }>(event)
  if (typeof body?.owner !== 'string' || !body.owner.trim() || body.owner.length > 4096
    || typeof body.action !== 'string' || !['check', 'stop', 'force_release'].includes(body.action)) {
    throw createError({ statusCode: 400, statusMessage: 'A valid permit owner and action are required.' })
  }
  if (body.action === 'force_release' && (body.confirmation !== body.owner
    || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000)) {
    throw createError({ statusCode: 400, statusMessage: 'Exact owner confirmation and a reason (1-2000 characters) are required.' })
  }
  return useIii().trigger({
    function_id: 'nworkflow::agent-permits-manage',
    payload: {
      owner: body.owner, action: body.action, actor,
      ...(body.action === 'force_release' ? { confirmation: body.confirmation, reason: String(body.reason).trim() } : {}),
    },
  })
})