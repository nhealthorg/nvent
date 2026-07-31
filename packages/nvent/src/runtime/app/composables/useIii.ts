/**
 * useIii (browser) — returns the connected iii-browser-sdk instance.
 *
 * Available as an auto-import in any Vue component or composable.
 * The instance is initialized once by the `iii.client.ts` plugin.
 *
 * ```ts
 * <script setup>
 * const iii = useIii()
 *
 * // Call a server function
 * const result = await iii.trigger({ function_id: 'greet', payload: { name: 'World' } })
 *
 * // Register a browser-side handler (server can call back into the browser)
 * iii.registerFunction('ui::notify', async (data) => {
 *   alert(data.message)
 * })
 * </script>
 * ```
 */

import { useNuxtApp } from '#imports'
import type { registerWorker } from 'iii-browser-sdk'

type IiiInstance = ReturnType<typeof registerWorker>
type IiiManager = {
  getIii?: () => IiiInstance
}

export function useIii(): IiiInstance {
  const nuxtApp = useNuxtApp()
  const manager = (nuxtApp as unknown as { $iiiManager?: IiiManager }).$iiiManager
  const iii = manager?.getIii?.() ?? (nuxtApp.$iii as IiiInstance | undefined)

  if (!iii) {
    throw new Error('[nvent] iii browser SDK not initialized. Is the app running in the browser?')
  }

  return iii
}
