// @ts-expect-error '#imports' is resolved by Nuxt/Nitro in consuming apps.
import { useRuntimeConfig, defineWebSocketHandler } from '#imports'

const CANONICAL_STREAM_NAME = 'nworkflow'
const RUN_ID_PATTERN = /^r_[0-9a-f]{32}$/

function isAllowedSubscription(streamName: string, groupId: string): boolean {
  return streamName === CANONICAL_STREAM_NAME && RUN_ID_PATTERN.test(groupId)
}

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
  open(peer: any) {
    const { nvent } = useRuntimeConfig()
    const host = (nvent as any).iii.httpHost as string
    const port = (nvent as any).iii.streamPort as number

    // Extract streamName and groupId from the request path.
    // Expected path: /_iii/stream/{streamName}/{groupId}[/]
    const rawUrl = peer.request.url
    const pathname = rawUrl.startsWith('http') ? new URL(rawUrl).pathname : rawUrl.split('?')[0]
    const parts = pathname.replace(/^\/_iii\/stream\//, '').replace(/\/$/, '').split('/')
    const streamName = parts[0] ?? ''
    const groupId = parts[1] ?? ''

    if (!isAllowedSubscription(streamName, groupId)) {
      peer.close(1008, '[nvent] Stream subscription rejected: invalid stream or run scope')
      return
    }

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

  message(peer: any, message: any) {
    // Forward any client messages (e.g. leave) to upstream.
    const upstream = peer.context._upstream as WebSocket | undefined
    if (upstream?.readyState === WebSocket.OPEN) {
      upstream.send(message.rawData as string)
    }
  },

  close(peer: any) {
    const upstream = peer.context._upstream as WebSocket | undefined
    if (upstream && upstream.readyState < WebSocket.CLOSING) {
      upstream.close()
    }
    delete peer.context._upstream
  },
})
