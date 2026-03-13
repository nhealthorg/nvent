/**
 * useFunctionCall — call a nvent function via the /functions/** proxy.
 *
 * ```ts
 * const { call, pending, data, error } = useFunctionCall('pipeline/start')
 * const result = await call({ text: 'Hello' })
 * // result may include a streamId to pass to useNventStream
 * ```
 */

import { ref } from 'vue'

export function useFunctionCall<TInput = unknown, TOutput = unknown>(path: string) {
  const pending = ref(false)
  const error = ref<Error | null>(null)
  const data = ref<TOutput | null>(null)

  /**
   * Call the function. `method` defaults to 'POST'.
   * For GET functions, pass method: 'GET' and use `params` instead of `body`.
   */
  async function call(input?: TInput, options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' } = {}): Promise<TOutput> {
    pending.value = true
    error.value = null
    try {
      const method = options.method ?? (input !== undefined ? 'POST' : 'GET')
      const result = await $fetch<TOutput>(`/functions/${path}`, {
        method,
        ...(method === 'GET' ? { params: input as Record<string, unknown> } : { body: input as unknown as Record<string, unknown> }),
      })
      data.value = result
      return result
    }
    catch (e) {
      error.value = e as Error
      throw e
    }
    finally {
      pending.value = false
    }
  }

  return { call, pending, data, error }
}
