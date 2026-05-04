/**
 * useIiiStream — subscribe to an iii stream group via WebSocket.
 *
 * The iii stream module serves WebSocket connections at:
 *   ws://host/_iii/stream/{stream_name}/{group_id}/
 *
 * Nitro proxies `/_iii/stream/**` → `ws://iii-engine:3112/`, so connecting
 * to the current page host is sufficient — no hardcoded ports needed.
 *
 * ```ts
 * const { messages, status, subscribe, close } = useIiiStream<MyEvent>()
 * subscribe('pipeline', jobId)   // start listening
 * // messages.value grows as events arrive
 * ```
 */

import { ref, onUnmounted } from 'vue'

export type IiiStreamStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error'

export function useIiiStream<TMessage = unknown>() {
  const messages = ref<TMessage[]>([])
  const status = ref<IiiStreamStatus>('idle')
  let ws: WebSocket | null = null

  function subscribe(streamName: string, groupId: string) {
    close()
    messages.value = []
    status.value = 'connecting'

    const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = typeof window !== 'undefined' ? window.location.host : 'localhost'
    ws = new WebSocket(`${protocol}//${host}/_iii/stream/${streamName}/${groupId}/`)

    ws.onopen = () => {
      status.value = 'connected'
    }

    ws.onmessage = (e: MessageEvent) => {
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

    ws.onerror = () => {
      status.value = 'error'
    }

    ws.onclose = () => {
      if (status.value !== 'error') status.value = 'closed'
      ws = null
    }
  }

  function close() {
    if (ws) {
      ws.close()
      ws = null
    }
    if (status.value !== 'idle') status.value = 'closed'
  }

  onUnmounted(close)

  return { messages, status, subscribe, close }
}
