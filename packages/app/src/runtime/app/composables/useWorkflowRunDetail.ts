import { computed, ref, watch, onMounted, type ComputedRef, type Ref } from 'vue'

export interface WorkflowRunStatusResponse {
  status: string
  definition: any
  nodes: Record<string, any>
  created_at: number
  updated_at: number
  result?: any
}

export interface WorkflowTimelineResponse {
  trace_ids: string[]
  spans: any[]
  logs: any[]
}

export interface WorkflowStatesResponse {
  states: Array<{ key: string, value: unknown }>
}

export interface WorkflowStreamsResponse {
  streams: string[]
}

export interface UseWorkflowRunDetailResult {
  status: Ref<WorkflowRunStatusResponse | null>
  statusPending: Ref<boolean>
  statusError: Ref<unknown>
  refreshStatus: () => Promise<void>
  timeline: Ref<WorkflowTimelineResponse | null>
  timelinePending: Ref<boolean>
  timelineError: Ref<unknown>
  refreshTimeline: () => Promise<void>
  workflowStates: Ref<WorkflowStatesResponse | null>
  statesPending: Ref<boolean>
  statesError: Ref<unknown>
  refreshStates: () => Promise<void>
  workflowStreams: Ref<WorkflowStreamsResponse | null>
  streamsPending: Ref<boolean>
  streamsError: Ref<unknown>
  refreshStreams: () => Promise<void>
  isLive: ComputedRef<boolean>
  refreshAll: () => Promise<void>
}

export function useWorkflowRunDetail(runId: Ref<string>): UseWorkflowRunDetailResult {
  const status = ref<WorkflowRunStatusResponse | null>(null)
  const timeline = ref<WorkflowTimelineResponse | null>(null)
  const workflowStates = ref<WorkflowStatesResponse | null>(null)
  const workflowStreams = ref<WorkflowStreamsResponse | null>(null)
  const statusPending = ref(false)
  const statusError = ref<unknown>(null)
  const timelinePending = ref(false)
  const timelineError = ref<unknown>(null)
  const statesPending = ref(false)
  const statesError = ref<unknown>(null)
  const streamsPending = ref(false)
  const streamsError = ref<unknown>(null)

  async function refreshStatus() {
    statusPending.value = true
    statusError.value = null
    try {
      status.value = await $fetch<WorkflowRunStatusResponse>('/api/_workflows/status', {
        params: { run_id: runId.value },
      })
    }
    catch (error) {
      statusError.value = error
    }
    finally {
      statusPending.value = false
    }
  }

  async function refreshTimeline() {
    timelinePending.value = true
    timelineError.value = null
    try {
      timeline.value = await $fetch<WorkflowTimelineResponse>('/api/_workflows/timeline', {
        params: { run_id: runId.value, limit: 500 },
      })
    }
    catch (error) {
      timelineError.value = error
    }
    finally {
      timelinePending.value = false
    }
  }

  async function refreshStates() {
    statesPending.value = true
    statesError.value = null
    try {
      workflowStates.value = await $fetch<WorkflowStatesResponse>('/api/_workflows/states', {
        params: { run_id: runId.value, limit: 500 },
      })
    }
    catch (error) {
      statesError.value = error
    }
    finally {
      statesPending.value = false
    }
  }

  async function refreshStreams() {
    streamsPending.value = true
    streamsError.value = null
    try {
      workflowStreams.value = await $fetch<WorkflowStreamsResponse>('/api/_workflows/streams', {
        params: { run_id: runId.value, limit: 500 },
      })
    }
    catch (error) {
      streamsError.value = error
    }
    finally {
      streamsPending.value = false
    }
  }

  const isLive = computed(() => {
    const currentStatus = status.value?.status
    return currentStatus === 'running' || currentStatus === 'awaiting_nodes' || currentStatus === 'awaiting'
  })

  async function refreshAll() {
    await Promise.all([
      refreshStatus(),
      refreshTimeline(),
      refreshStates(),
      refreshStreams(),
    ])
  }

  onMounted(() => {
    void refreshAll()
  })

  watch(runId, () => {
    void refreshAll()
  })

  return {
    status,
    statusPending,
    statusError,
    refreshStatus,
    timeline,
    timelinePending,
    timelineError,
    refreshTimeline,
    workflowStates,
    statesPending,
    statesError,
    refreshStates,
    workflowStreams,
    streamsPending,
    streamsError,
    refreshStreams,
    isLive,
    refreshAll,
  }
}
