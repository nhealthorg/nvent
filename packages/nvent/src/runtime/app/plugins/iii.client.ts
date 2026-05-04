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
import { registerWorker } from 'iii-browser-sdk'

export default defineNuxtPlugin((nuxtApp) => {
  const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = typeof window !== 'undefined' ? window.location.host : 'localhost'
  const url = `${protocol}//${host}/_iii/browser`

  const iii = registerWorker(url)

  nuxtApp.provide('iii', iii)
})
