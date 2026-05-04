import { defineWebSocketHandler } from 'h3'

/**
 * WebSocket proxy for the iii Stream module.
 *
 * The iii stream module listens on its own port (default 3112) and only accepts
 * connections at the root path `ws://host:3112/`. After connecting, the client
 * must send a join message to subscribe to a stream group:
 *
 *   { type: 'join', data: { streamName, groupId, subscriptionId } }
 *
 * This handler matches `/_iii/stream/{streamName}/{groupId}[/]` on the Nuxt/Nitro
 * side, extracts the stream name and group ID from the URL path, connects to
 * the upstream root, sends the join message, and then transparently bridges
 * all subsequent messages so the browser never needs to know about port 3112
 * or the join protocol.
 */
export default defineWebSocketHandler({
  open(peer) {
    const { nvent } = useRuntimeConfig()
    const host = nvent.iii.httpHost as string
    const port = nvent.iii.streamPort as number

    // Extract streamName and groupId from the request path.
    // Expected path: /_iii/stream/{streamName}/{groupId}[/]
    const rawUrl = peer.request.url
    const pathname = rawUrl.startsWith('http') ? new URL(rawUrl).pathname : rawUrl.split('?')[0]
    const parts = pathname.replace(/^\/_iii\/stream\//, '').replace(/\/$/, '').split('/')
    const streamName = parts[0] ?? ''
    const groupId = parts[1] ?? ''

    // The iii stream module only accepts connections at the root path.
    const upstreamUrl = `ws://${host}:${port}/`
    const upstream = new WebSocket(upstreamUrl)

    peer.context._upstream = upstream

    upstream.addEventListener('open', () => {
      // Immediately subscribe to the requested stream group.
      const subscriptionId = crypto.randomUUID()
      upstream.send(JSON.stringify({
        type: 'join',
        data: { streamName, groupId, subscriptionId },
      }))
    })

    upstream.addEventListener('message', (e) => {
      peer.send(typeof e.data === 'string' ? e.data : JSON.stringify(e.data))
    })

    upstream.addEventListener('close', (e) => {
      peer.close(e.code, e.reason)
    })

    upstream.addEventListener('error', () => {
      peer.close(1011, 'Upstream stream error')
    })
  },

  message(peer, message) {
    // Forward any client messages (e.g. leave) to upstream.
    const upstream = peer.context._upstream as WebSocket | undefined
    if (upstream?.readyState === WebSocket.OPEN) {
      upstream.send(message.rawData as string)
    }
  },

  close(peer) {
    const upstream = peer.context._upstream as WebSocket | undefined
    if (upstream && upstream.readyState < WebSocket.CLOSING) {
      upstream.close()
    }
    delete peer.context._upstream
  },
})
