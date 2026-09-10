import { computed, ref, watch, onUnmounted, type Ref } from 'vue'
import { useIiiStream } from './useIiiStream'

export interface WorkflowStreamSubscription {
  streamName: string
  groupId: string
}

export interface WorkflowStreamEvent<T = unknown> {
  type: string
  data: T
  runId?: string
  nodeUid?: string
  tsUnixMs?: number
}

function toSubscription(subOrRunId: string | WorkflowStreamSubscription): WorkflowStreamSubscription {
  if (typeof subOrRunId === 'string') {
    return { streamName: 'nworkflow', groupId: subOrRunId }
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

  const stream = useIiiStream<unknown>()
  let processed = 0

  function normalizeEvent(payload: unknown): WorkflowStreamEvent {
    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>
      if (typeof obj.type === 'string' && 'data' in obj) {
        return {
          type: obj.type,
          data: obj.data,
          runId: typeof obj.run_id === 'string' ? obj.run_id : undefined,
          nodeUid: typeof obj.node_uid === 'string' ? obj.node_uid : undefined,
          tsUnixMs: typeof obj.ts_unix_ms === 'number' ? obj.ts_unix_ms : undefined,
        }
      }
    }

    return {
      type: 'message',
      data: payload,
    }
  }

  watch(stream.messages, (all) => {
    while (processed < all.length) {
      const payload = all[processed]
      events.value = [...events.value, normalizeEvent(payload)]
      processed++
    }
  }, { immediate: true })

  watch(stream.status, (s) => {
    status.value = s
  }, { immediate: true })

  function subscribe(subOrRun: string | WorkflowStreamSubscription) {
    current.value = toSubscription(subOrRun)
    events.value = []
    processed = 0
    if (current.value) {
      stream.subscribe(current.value.streamName, current.value.groupId)
    }
  }

  function matchesPattern(type: string, pattern: string): boolean {
    const p = pattern.trim()
    if (!p) return false
    if (p.endsWith('.*')) {
      const prefix = p.slice(0, -2)
      return type === prefix || type.startsWith(`${prefix}.`)
    }
    return type === p
  }

  /**
   * Listen to events from ctx.workflow.stream.send(type, data).
   *
   * Pattern support:
   * - Exact type:   listen('phase')
   * - Prefix group: listen('agents.*')
   */
  function listen<T = unknown>(type: string): Ref<T[]> {
    return computed(() => {
      return events.value
        .filter((event) => matchesPattern(event.type, type))
        .map((event) => event.data as T)
    })
  }

  /**
   * Listen to full normalized event objects by exact type or prefix pattern.
   *
   * Example:
   * - listenEvents('agents.*')
   * - listenEvents('phase')
   */
  function listenEvents<T = unknown>(pattern: string): Ref<WorkflowStreamEvent<T>[]> {
    return computed(() => {
      return events.value
        .filter((event) => matchesPattern(event.type, pattern)) as WorkflowStreamEvent<T>[]
    })
  }

  /**
   * Compatibility alias for grouped subscriptions.
   * Prefer listen('agents.*') for new code.
   */
  function listenPart<T = unknown>(part: string): Ref<WorkflowStreamEvent<T>[]> {
    return listenEvents<T>(`${part.trim()}.*`)
  }

  if (sub) {
    subscribe(sub)
  }

  function close() {
    stream.close()
    processed = 0
    events.value = []
    current.value = null
    status.value = 'closed'
  }

  onUnmounted(() => {
    close()
  })

  return {
    listen,
    listenEvents,
    listenPart,
    subscribe,
    status,
    close,
    events,
  }
}
