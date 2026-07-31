/**
 * iii browser SDK plugin — client-only.
 *
 * Connects the iii-browser-sdk to the RBAC WebSocket port proxied by Nitro
 * at `/_iii/browser`. The connected instance is stored as `nuxtApp.$iii` so
 * it is accessible via `useIii()` in any component or composable.
 *
 * The WebSocket URL is derived from the current page host — no hardcoded ports.
 * In dev, Nitro proxies `/_iii/browser` → `ws://localhost:{rbacPort}`.
 * In production, the same Nitro server handles the proxy.
 */

import { defineNuxtPlugin } from '#imports'
import { registerWorker, type IIIConnectionState } from 'iii-browser-sdk'

type IiiInstance = ReturnType<typeof registerWorker>
type IiiManager = {
  getIii: () => IiiInstance
  resetIii: (reason?: string) => Promise<IiiInstance>
}

function buildBrowserWorkerUrl(): string {
  const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = typeof window !== 'undefined' ? window.location.host : 'localhost'
  return `${protocol}//${host}/_iii/browser`
}

export default defineNuxtPlugin((nuxtApp) => {
  const url = buildBrowserWorkerUrl()
  let activeIii: IiiInstance | null = null
  let resetInFlight: Promise<IiiInstance> | null = null
  let lastResetMs = 0

  function createWorker(): IiiInstance {
    const worker = registerWorker(url, {
      invocationTimeoutMs: 15_000,
      reconnectionConfig: {
        initialDelayMs: 300,
        maxDelayMs: 5000,
        backoffMultiplier: 1.8,
        jitterFactor: 0.2,
        maxRetries: -1,
      },
    })

    worker.addConnectionStateListener((state: IIIConnectionState) => {
      if (state !== 'failed') return
      // Recreate worker on terminal connection state to recover from broken pipes.
      void resetIii('failed-state')
    })

    return worker
  }

  async function resetIii(reason = 'manual'): Promise<IiiInstance> {
    if (resetInFlight) return resetInFlight

    const now = Date.now()
    const minResetIntervalMs = 1500
    if (now - lastResetMs < minResetIntervalMs) {
      return activeIii ?? (activeIii = createWorker())
    }

    resetInFlight = (async () => {
      const previous = activeIii
      activeIii = null
      lastResetMs = Date.now()

      try {
        await previous?.shutdown()
      }
      catch {
        // Ignore shutdown errors while rebuilding the browser SDK client.
      }

      const next = createWorker()
      activeIii = next
      return next
    })()

    try {
      return await resetInFlight
    }
    finally {
      resetInFlight = null
      void reason
    }
  }

  activeIii = createWorker()
  const manager: IiiManager = {
    getIii: () => activeIii ?? (activeIii = createWorker()),
    resetIii,
  }

  nuxtApp.provide('iii', activeIii)
  nuxtApp.provide('iiiManager', manager)
  nuxtApp.provide('resetIii', resetIii)
})
