/**
 * useIii — returns the iii SDK instance stored by the worker plugin.
 *
 * Available in any Nitro event handler or iii function:
 * ```ts
 * const { iii } = useIii()
 * const result = await iii.trigger('orders::process', data)
 *
 * // Inside a registered function handler, get the execution context separately:
 * const { iii } = useIii()
 * const { logger } = getContext()  // auto-imported from iii-sdk via #imports
 * ```
 */

import { useNitroApp } from '#imports'
import type { registerWorker } from 'iii-sdk'

type IiiInstance = ReturnType<typeof registerWorker>

export function useIii(): { iii: IiiInstance } {
  const nitroApp = useNitroApp()
  const iii = (nitroApp as any).$iii as IiiInstance | undefined

  if (!iii) {
    throw new Error('[nvent] iii SDK not initialized. Is the iii-worker Nitro plugin loaded?')
  }

  return { iii }
}

/**
 * useIiiHealth — returns the current engine health status.
 */
export async function useIiiHealth(): Promise<Record<string, unknown>> {
  const { iii } = useIii()
  return iii.trigger('engine::health::check', {}) as Promise<Record<string, unknown>>
}

export { getContext } from 'iii-sdk'
