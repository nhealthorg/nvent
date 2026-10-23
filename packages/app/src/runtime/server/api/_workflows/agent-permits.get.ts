import { defineEventHandler, useIii } from '#imports'
import { requireAgentPermitAdmin } from '../../utils/agentPermitAdmin'

export default defineEventHandler(async event => {
  requireAgentPermitAdmin(event)
  return useIii().trigger({ function_id: 'nworkflow::agent-permits-list', payload: {} })
})