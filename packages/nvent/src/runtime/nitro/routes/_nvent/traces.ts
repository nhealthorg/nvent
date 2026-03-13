import { defineEventHandler } from 'h3'
import { useIii } from '../../utils/useIii'

export default defineEventHandler(async () => {
  const { iii } = useIii()
  return iii.trigger('engine::traces::list', {})
})
