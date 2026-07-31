import { createBrowserAuthToken } from '../utils/browserAuthToken'
// @ts-expect-error '#imports' is resolved by Nuxt/Nitro in consuming apps.
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
  open(peer: any) {
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
    const pendingMessages: Array<string | ArrayBuffer> = []
    const maxPendingMessages = 512
    const maxInitialReconnects = 12
    const reconnectBaseDelayMs = 200
    let upstreamOpenedOnce = false
    let upstreamReconnectAttempts = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    peer.context._closedByPeer = false
    peer.context._maxPendingMessages = maxPendingMessages

    function isClosedByPeer() {
      return Boolean(peer.context._closedByPeer)
    }

    function clearReconnectTimer() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
        delete peer.context._reconnectTimer
      }
    }

    function scheduleReconnect() {
      if (isClosedByPeer() || reconnectTimer || upstreamReconnectAttempts >= maxInitialReconnects) {
        try {
          peer.close(1011, 'Upstream browser-worker unavailable')
        }
        catch {
          // ignore close errors on already-closed sockets
        }
        return
      }

      const expDelay = Math.min(reconnectBaseDelayMs * 2 ** upstreamReconnectAttempts, 3000)
      const jitter = expDelay * 0.2 * (Math.random() * 2 - 1)
      upstreamReconnectAttempts++
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        delete peer.context._reconnectTimer
        if (!isClosedByPeer()) {
          connectUpstream()
        }
      }, Math.max(0, expDelay + jitter))
      peer.context._reconnectTimer = reconnectTimer
    }

    function connectUpstream() {
      const upstream = new WebSocket(upstreamUrl)

      peer.context._upstream = upstream
      peer.context._pendingMessages = pendingMessages

      // Prefer ArrayBuffer payloads for binary frames when supported.
      try {
        upstream.binaryType = 'arraybuffer'
      }
      catch {
        // no-op
      }

      upstream.addEventListener('open', () => {
        clearReconnectTimer()
        upstreamOpenedOnce = true
        upstreamReconnectAttempts = 0
        for (const payload of pendingMessages) {
          upstream.send(payload)
        }
        pendingMessages.length = 0
      })

      upstream.addEventListener('message', async (e) => {
        if (typeof e.data === 'string') {
          peer.send(e.data)
          return
        }

        if (e.data instanceof ArrayBuffer) {
          peer.send(Buffer.from(e.data))
          return
        }

        if (ArrayBuffer.isView(e.data)) {
          const view = e.data as ArrayBufferView
          peer.send(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
          return
        }

        if (typeof Blob !== 'undefined' && e.data instanceof Blob) {
          const ab = await e.data.arrayBuffer()
          peer.send(Buffer.from(ab))
          return
        }

        // Fallback for unknown payload shapes.
        peer.send(String(e.data ?? ''))
      })

      upstream.addEventListener('close', (e) => {
        if (isClosedByPeer()) return
        if (!upstreamOpenedOnce) {
          scheduleReconnect()
          return
        }
        peer.close(e.code, e.reason)
      })

      upstream.addEventListener('error', () => {
        // Most runtimes follow with `close`; reconnect/close is handled there.
      })
    }

    connectUpstream()
  },

  message(peer: any, message: any) {
    const upstream = peer.context._upstream as WebSocket | undefined
    const pendingMessages = peer.context._pendingMessages as Array<string | ArrayBuffer> | undefined

    // Preserve wire format; iii-browser-sdk may use binary frames.
    const raw = message.rawData
    const payload: string | ArrayBuffer = typeof raw === 'string'
      ? raw
      : ArrayBuffer.isView(raw)
        ? (raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)
        : raw instanceof ArrayBuffer
          ? raw
          : String(raw)

    if (upstream?.readyState === WebSocket.OPEN) {
      upstream.send(payload)
      return
    }

    // SDK may emit registration/invocation frames immediately after browser connect.
    // Queue them until the upstream RBAC socket reaches OPEN to avoid frame loss.
    if ((upstream?.readyState === WebSocket.CONNECTING || !upstream) && pendingMessages) {
      if (pendingMessages.length >= (peer.context._maxPendingMessages as number ?? 512)) {
        pendingMessages.shift()
      }
      pendingMessages.push(payload)
    }
  },

  close(peer: any) {
    peer.context._closedByPeer = true
    const reconnectTimer = peer.context._reconnectTimer as ReturnType<typeof setTimeout> | undefined
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
    }
    const upstream = peer.context._upstream as WebSocket | undefined
    upstream?.close()
    delete peer.context._pendingMessages
    delete peer.context._maxPendingMessages
  },
})
