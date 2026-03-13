import { defineEventHandler, getRouterParam, readBody } from 'h3'
import { useIii } from '../../utils/useIii'

export default defineEventHandler(async (event) => {
  const { iii } = useIii()
  const id = getRouterParam(event, 'id')
  if (!id) return { error: 'Missing function id' }
  const body = await readBody(event).catch(() => ({}))
  return iii.trigger(id, body ?? {})
})
