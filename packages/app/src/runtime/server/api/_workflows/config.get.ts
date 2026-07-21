import { defineEventHandler, useIii } from '#imports'

export default defineEventHandler(async () => {
  const iii = useIii()
  const response = await iii.trigger({
    function_id: 'workflow::config',
    payload: {},
  })

  return response
})
