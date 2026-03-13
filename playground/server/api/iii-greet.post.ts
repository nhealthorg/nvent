/**
 * POST /api/greet — calls the iii 'greet' function via useIii()
 */
export default defineEventHandler(async (event) => {
  const { iii } = useIii()
  const body = await readBody(event).catch(() => ({}))
  return iii.trigger('greet', body ?? {})
})
