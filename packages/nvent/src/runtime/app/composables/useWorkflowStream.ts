import { computed, ref, watch, onUnmounted, type Ref } from 'vue'
import { useIiiStream } from './useIiiStream'

export interface WorkflowStreamSubscription {
  streamName: string
  groupId: string
}

export interface WorkflowStreamEvent<T = unknown> {
  id?: string
  type: string
  data: T
  runId?: string
  nodeUid?: string
  functionId?: string
  tsUnixMs?: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function unwrapWorkflowEvent(payload: unknown): { event: Record<string, unknown>, envelope: Record<string, unknown> } | null {
  const envelope = asRecord(payload)
  if (!envelope) return null

  const protocolEvent = asRecord(envelope.event)
  if (protocolEvent?.type === 'event') {
    const event = asRecord(protocolEvent.event)
    if (event) return { event, envelope }
  }

  return { event: envelope, envelope }
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
  const seenEventKeys = new Set<string>()

  function normalizeEvent(payload: unknown): WorkflowStreamEvent {
    const normalized = unwrapWorkflowEvent(payload)
    if (normalized) {
      const { event, envelope } = normalized
      const type = typeof event.type === 'string'
        ? event.type
        : (typeof event.event_name === 'string' ? event.event_name : 'message')
      if ('data' in event || type !== 'message') {
        return {
          id: typeof envelope.id === 'string'
            ? envelope.id
            : (typeof event.id === 'string' ? event.id : undefined),
          type,
          data: 'data' in event ? event.data : event,
          runId: typeof event.run_id === 'string' ? event.run_id : undefined,
          nodeUid: typeof event.node_uid === 'string' ? event.node_uid : undefined,
          functionId: typeof event.function_id === 'string' ? event.function_id : undefined,
          tsUnixMs: typeof event.ts_unix_ms === 'number'
            ? event.ts_unix_ms
            : (typeof envelope.timestamp === 'number' ? envelope.timestamp : undefined),
        }
      }
    }

    return {
      type: 'message',
      data: payload,
    }
  }

  function eventKey(event: WorkflowStreamEvent): string {
    if (event.id) return `id:${event.id}`
    return JSON.stringify([event.type, event.runId, event.nodeUid, event.functionId, event.tsUnixMs, event.data])
  }

  watch(stream.messages, (all) => {
    while (processed < all.length) {
      const payload = all[processed]
      const event = normalizeEvent(payload)
      const key = eventKey(event)
      if (!seenEventKeys.has(key)) {
        seenEventKeys.add(key)
        events.value = [...events.value, event]
      }
      processed++
    }
  }, { immediate: true })

  watch(stream.status, (s) => {
    status.value = s
  }, { immediate: true })

  function subscribe(subOrRun: string | WorkflowStreamSubscription) {
    current.value = toSubscription(subOrRun)
    events.value = []
    seenEventKeys.clear()
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
    seenEventKeys.clear()
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
