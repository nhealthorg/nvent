import { createBrowserAuthToken } from '../utils/browserAuthToken'
import { useRuntimeConfig, defineWebSocketHandler } from '#imports'

/**
 * WebSocket proxy for the iii RBAC browser worker port.
 *
 * Browser tabs connect to `/_iii/browser` on the Nuxt/Nitro server.
 * This handler transparently forwards the WebSocket to the iii RBAC port
 * (configured via `nvent.iii.browserPort`), which enforces RBAC policies
 * defined by the auth function (`nvent::browser::auth`).
 *
 * The browser never needs to know about the internal iii port — all traffic
 * flows through the Nuxt server origin.
 */
export default defineWebSocketHandler({
  open(peer) {
    const { nvent } = useRuntimeConfig()
    const host = (nvent as any).iii.httpHost as string
    const port = (nvent as any).iii.browserPort as number
    const authCfg = (nvent as any).iii.browserAuth ?? {}

    if (!port) {
      peer.close(1011, '[nvent] Browser RBAC port not configured (nvent.iii.browserPort)')
      return
    }

    const requestHeaders: Record<string, string> = {}
    for (const [k, v] of peer.request.headers.entries()) {
      requestHeaders[k.toLowerCase()] = v
    }

    const rawUrl = peer.request.url
    const pathname = rawUrl.startsWith('http') ? new URL(rawUrl).pathname : rawUrl.split('?')[0]
    const iat = Math.floor(Date.now() / 1000)
    const exp = iat + Number(authCfg.tokenTtlSeconds ?? 120)
    const token = createBrowserAuthToken(
      {
        iat,
        exp,
        request: {
          headers: requestHeaders,
          path: pathname,
        },
      },
      String(authCfg.secret ?? ''),
    )

    const upstreamUrl = `ws://${host}:${port}/?_nvent_token=${encodeURIComponent(token)}`
    const upstream = new WebSocket(upstreamUrl)

    peer.context._upstream = upstream

    upstream.addEventListener('message', (e) => {
      peer.send(typeof e.data === 'string' ? e.data : JSON.stringify(e.data))
    })

    upstream.addEventListener('close', (e) => {
      peer.close(e.code, e.reason)
    })

    upstream.addEventListener('error', () => {
      peer.close(1011, 'Upstream browser-worker error')
    })
  },

  message(peer, message) {
    const upstream = peer.context._upstream as WebSocket | undefined
    if (upstream?.readyState === WebSocket.OPEN) {
      upstream.send(message.text())
    }
  },

  close(peer) {
    const upstream = peer.context._upstream as WebSocket | undefined
    upstream?.close()
  },
})
