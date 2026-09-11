import { computed, ref } from '#imports'

export interface WorkflowStreamSubscription {
  streamName: 'nworkflow'
  groupId: string
}

function normalizeSubscription(value: unknown, runId?: string): WorkflowStreamSubscription | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const streamName = String(v.streamName || '')
  const groupId = String(v.groupId || '')
  if (streamName !== 'nworkflow' || !groupId) return null
  if (runId && groupId !== runId) return null
  return { streamName: 'nworkflow', groupId }
}

export function useWorkflowStreamAccess() {
  const subscription = ref<WorkflowStreamSubscription | null>(null)

  function setFromTriggerResult(result: unknown): WorkflowStreamSubscription | null {
    const payload = (result && typeof result === 'object') ? (result as Record<string, unknown>) : {}
    const runId = payload.run_id ? String(payload.run_id) : undefined
    const next = normalizeSubscription(payload.stream, runId)
    subscription.value = next
    return next
  }

  function clear() {
    subscription.value = null
  }

  return {
    subscription: computed(() => subscription.value),
    setFromTriggerResult,
    clear,
  }
}
