import { ref, watch, onUnmounted, type Ref } from 'vue'
import { useIiiStream } from './useIiiStream'

export interface WorkflowStreamSubscription {
  streamName: string
  groupId: string
}

export interface WorkflowStreamEvent<T = unknown> {
  type: string
  data: T
}

function toSubscription(subOrRunId: string | WorkflowStreamSubscription): WorkflowStreamSubscription {
  if (typeof subOrRunId === 'string') {
    return { streamName: 'workflow', groupId: subOrRunId }
  }
  return subOrRunId
}

export function useWorkflowStream(subOrRunId?: string | WorkflowStreamSubscription) {
  const sub: WorkflowStreamSubscription | undefined = subOrRunId
    ? toSubscription(subOrRunId)
    : undefined

  const status = ref<'idle' | 'connecting' | 'connected' | 'closed' | 'error'>('idle')
  const events = ref<WorkflowStreamEvent[]>([])
  const current = ref<WorkflowStreamSubscription | null>(sub ?? null)

  type ChannelState = {
    data: Ref<unknown[]>
    stream: ReturnType<typeof useIiiStream<unknown>>
    processed: number
  }

  const channels = new Map<string, ChannelState>()

  function ensureChannel(type: string): ChannelState {
    const existing = channels.get(type)
    if (existing) return existing

    const stream = useIiiStream<unknown>()
    const data = ref<unknown[]>([])
    const channel: ChannelState = {
      data,
      stream,
      processed: 0,
    }

    watch(stream.messages, (all) => {
      while (channel.processed < all.length) {
        const payload = all[channel.processed]
        channel.data.value = [...channel.data.value, payload]
        events.value = [...events.value, { type, data: payload }]
        channel.processed++
      }
    }, { immediate: true })

    watch(stream.status, (s) => {
      status.value = s
    }, { immediate: true })

    if (current.value?.groupId) {
      // nworkflow::stream-publish uses stream=<type>, group_id=<run_id>
      stream.subscribe(type, current.value.groupId)
    }

    channels.set(type, channel)
    return channel
  }

  function subscribe(subOrRun: string | WorkflowStreamSubscription) {
    current.value = toSubscription(subOrRun)
    events.value = []
    for (const [type, channel] of channels.entries()) {
      channel.processed = 0
      channel.data.value = []
      if (current.value?.groupId) {
        channel.stream.subscribe(type, current.value.groupId)
      }
    }
  }

  /**
   * Listen to events from ctx.workflow.stream.send(type, data).
   *
   * Example:
   * const chunks = stream.listen<string>('chat-update')
   * // chunks.value contains all payloads for that event type
   */
  function listen<T = unknown>(type: string): Ref<T[]> {
    const channel = ensureChannel(type)
    return channel.data as Ref<T[]>
  }

  if (sub) {
    subscribe(sub)
  }

  function close() {
    for (const channel of channels.values()) {
      channel.stream.close()
      channel.processed = 0
      channel.data.value = []
    }
    events.value = []
    current.value = null
    status.value = 'closed'
  }

  onUnmounted(() => {
    close()
  })

  return {
    listen,
    subscribe,
    status,
    close,
    events,
  }
}
