/**
 * useIiiStream — subscribe to an iii stream group via WebSocket.
 *
 * Connects to the iii engine's built-in stream WebSocket endpoint:
 *   ws://host/_iii/stream/{stream_name}/{group_id}/
 *
 * Nitro proxies `/_iii/stream/**` → `ws://iii-engine:3112/`, so connecting
 * to the current page host is sufficient — no hardcoded ports needed.
 *
 * **Authentication**: The browser WebSocket API does not support custom
 * headers. The iii engine uses cookie-based auth for WebSocket connections
 * (same session cookies as the rest of the app), so auth is handled
 * automatically without any additional configuration.
 *
 * **Reconnection**: The composable implements exponential backoff with jitter.
 * When the connection drops unexpectedly it will retry up to `maxRetries`
 * times (default: 10) before giving up and setting status to `'error'`.
 * Calling `subscribe()` again with new arguments or after an intentional
 * `close()` always resets the retry counter and starts fresh.
 *
 * **No unnecessary reconnects**: Calling `subscribe()` with the same
 * `streamName`/`groupId` while already connected is a no-op.
 *
 *
 * ```ts
 * const { messages, status, subscribe, close } = useIiiStream<MyEvent>()
 * subscribe('pipeline', jobId)   // start listening; auto-reconnects on drop
 * // messages.value grows as events arrive
 * ```
 */

import { ref, onUnmounted } from 'vue'

export type IiiStreamStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error'

export interface IiiStreamOptions {
  /** Maximum number of reconnect attempts before giving up. Default: 10. */
  maxRetries?: number
  /** Base delay in ms for the first reconnect attempt. Default: 500. */
  baseDelayMs?: number
  /** Maximum delay in ms between reconnect attempts. Default: 30_000. */
  maxDelayMs?: number
}

export function useIiiStream<TMessage = unknown>(options: IiiStreamOptions = {}) {
  const {
    maxRetries = 10,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
  } = options

  const messages = ref<TMessage[]>([])
  const status = ref<IiiStreamStatus>('idle')

  let ws: WebSocket | null = null
  let currentStreamName: string | null = null
  let currentGroupId: string | null = null
  let retryCount = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let intentionalClose = false

  function buildUrl(streamName: string, groupId: string): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    return `${protocol}//${host}/_iii/stream/${encodeURIComponent(streamName)}/${encodeURIComponent(groupId)}/`
  }

  function clearRetryTimer() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function connect(streamName: string, groupId: string) {
    if (typeof window === 'undefined') return

    status.value = 'connecting'

    const socket = new WebSocket(buildUrl(streamName, groupId))
    ws = socket

    socket.onopen = () => {
      retryCount = 0
      status.value = 'connected'
    }

    socket.onmessage = (e: MessageEvent) => {
      try {
        const envelope = JSON.parse(e.data)
        // Unwrap the iii stream protocol envelope.
        // Item events: { streamName, groupId, id, timestamp, event: { type, data } }
        // Group sync:  { streamName, groupId, timestamp, event: { type: 'sync', data: [] } }
        // Custom send: { streamName, groupId, timestamp, event: { type: 'event', event: {...} } }
        let payload: unknown
        if (envelope?.event?.type === 'event') {
          payload = envelope.event.event
        }
        else if (envelope?.event?.data !== undefined) {
          payload = envelope.event.data
        }
        else {
          payload = envelope
        }
        // For group sync, data is an array — flatten into the messages list.
        if (Array.isArray(payload)) {
          messages.value = [...messages.value, ...(payload as TMessage[])]
        }
        else {
          messages.value = [...messages.value, payload as TMessage]
        }
      }
      catch {
        messages.value = [...messages.value, e.data as unknown as TMessage]
      }
    }

    socket.onerror = () => {
      // onerror is always followed by onclose; handle retry there.
    }

    socket.onclose = (event) => {
      ws = null
      if (intentionalClose) {
        status.value = 'closed'
        return
      }
      // Unexpected close — attempt reconnect with exponential backoff + jitter.
      if (retryCount >= maxRetries) {
        status.value = 'error'
        currentStreamName = null
        currentGroupId = null
        return
      }
      const delay = Math.min(baseDelayMs * 2 ** retryCount, maxDelayMs)
      // ±25 % jitter to avoid thundering herds
      const jitter = delay * 0.25 * (Math.random() * 2 - 1)
      retryCount++
      status.value = 'connecting'
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (!intentionalClose && currentStreamName && currentGroupId) {
          connect(currentStreamName, currentGroupId)
        }
      }, Math.max(0, delay + jitter))
    }
  }

  function subscribe(streamName: string, groupId: string) {
    // No-op if already connected to the same stream/group.
    if (
      !intentionalClose
      && ws !== null
      && ws.readyState === WebSocket.OPEN
      && currentStreamName === streamName
      && currentGroupId === groupId
    ) {
      return
    }

    // Close any existing connection first.
    close()

    intentionalClose = false
    retryCount = 0
    messages.value = []
    currentStreamName = streamName
    currentGroupId = groupId

    connect(streamName, groupId)
  }

  function close() {
    intentionalClose = true
    clearRetryTimer()
    if (ws) {
      ws.close()
      ws = null
    }
    if (status.value !== 'idle') {
      status.value = 'closed'
    }
    currentStreamName = null
    currentGroupId = null
  }

  onUnmounted(close)

  return { messages, status, subscribe, close }
}
