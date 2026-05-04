/**
 * useIii — returns the raw iii SDK instance stored by the worker plugin.
 *
 * Available in any Nitro event handler or server utility:
 * ```ts
 * // server/api/health.get.ts
 * import { useIii } from '#nvent/server'
 *
 * export default defineEventHandler(async () => {
 *   const iii = useIii()
 *   return iii.trigger({ function_id: 'engine::health::check', payload: {} })
 * })
 * ```
 */

import { useNitroApp } from '#imports'
import type { registerWorker } from 'iii-sdk'

type IiiInstance = ReturnType<typeof registerWorker>

export function useIii(): IiiInstance {
  const nitroApp = useNitroApp()
  const iii = (nitroApp as any).$iii as IiiInstance | undefined

  if (!iii) {
    throw new Error('[nvent] iii SDK not initialized. Is the iii-worker Nitro plugin loaded?')
  }

  return iii
}

/**
 * useIiiHealth — returns the current engine health status.
 */
export async function useIiiHealth(): Promise<Record<string, unknown>> {
  const iii = useIii()
  return iii.trigger({ function_id: 'engine::health::check', payload: {} }) as Promise<Record<string, unknown>>
}


