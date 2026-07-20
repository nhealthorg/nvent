<script setup lang="ts">
import { computed, ref, useComponentRouter, onMounted, onUnmounted, watch } from '#imports'
import type { ComputedRef, Ref } from 'vue'
import { useWorkflowAnalysis } from '../../composables/useWorkflowAnalysis'

const { sortNodesByLevel, analyzeWorkflow } = useWorkflowAnalysis()
const { push, route } = useComponentRouter()

const props = defineProps<{
  runId?: string
}>()

const runId = computed(() => props.runId || (route.value.params.id as string))

const isStateSlideoverOpen = ref(false)
const isStreamSlideoverOpen = ref(false)

interface WorkflowRunStatusResponse {
  status: string
  definition: any
  nodes: Record<string, any>
  created_at: number
  updated_at: number
  result?: any
}

interface WorkflowTimelineResponse {
  trace_ids: string[]
  spans: any[]
  logs: any[]
}

interface WorkflowStatesResponse {
  states: Array<{ key: string, value: unknown }>
}

interface WorkflowStreamsResponse {
  streams: Array<{
    streamName: string
    items: Array<{
      id: string
      item_id?: string
      run_id?: string
      node_uid?: string
      function_id?: string
      ts_unix_ms?: number
      data?: unknown
    }>
  }>
}

interface UseWorkflowRunDetailResult {
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

function useWorkflowRunDetail(runIdRef: Ref<string>): UseWorkflowRunDetailResult {
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
        params: { run_id: runIdRef.value },
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
        params: { run_id: runIdRef.value, limit: 500 },
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
        params: { run_id: runIdRef.value, limit: 500 },
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
        params: { run_id: runIdRef.value, limit: 500 },
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
    ])
  }

  onMounted(() => {
    void refreshAll()
  })

  watch(runIdRef, () => {
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

const {
  status,
  statusPending: pending,
  statusError: error,
  refreshStatus: refresh,
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
  refreshAll: refreshAllData,
} = useWorkflowRunDetail(runId)

const definition = computed(() => status.value?.definition)

let refreshInterval: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  refreshInterval = setInterval(() => {
    if (status.value?.status === 'running' || status.value?.status === 'awaiting_nodes' || status.value?.status === 'awaiting') {
      refreshAllData()
    }
  }, 3000)
})

onUnmounted(() => {
  if (refreshInterval) clearInterval(refreshInterval)
})

const normalizedStatus = computed(() => {
  const currentStatus = status.value?.status
  if (currentStatus === 'done') return 'completed'
  if (currentStatus === 'error') return 'failed'
  if (currentStatus === 'awaiting_nodes' || currentStatus === 'awaiting') return 'running'
  return currentStatus
})

function nanosToMs(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num <= 0) return 0
  return Math.floor(num / 1_000_000)
}

function normalizeTraceAttributes(value: unknown): Record<string, any> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .filter((entry): entry is [string, unknown] => Array.isArray(entry) && entry.length >= 2 && typeof entry[0] === 'string')
        .map(([key, attrValue]) => [key, attrValue]),
    )
  }

  if (value && typeof value === 'object') return value as Record<string, any>
  return {}
}

const workflowStreamRefs = computed(() => {
  return workflowStreams.value?.streams ?? []
})

const flowMeta = computed(() => {
  if (!definition.value?.nodes) return null

  const analyzed = analyzeWorkflow(definition.value.nodes)
  const steps: Record<string, any> = {}

  Object.entries(definition.value.nodes).forEach(([id, node]: [string, any]) => {
    steps[id] = {
      name: id,
      workerId: node.function?.id,
      runtime: node.function?.runtime,
      dependsOn: node.depends_on || [],
      queue: node.function?.queue || 'default',
      engineRetryMax: node.function?.engine_retry?.max_attempts,
      runtype: (node as any).runtype || 'task',
      emits: (node as any).emits || [],
    }
  })

  let entry
  if (analyzed.levels[0]?.length === 1) {
    const entryId = analyzed.levels[0][0]
    if (entryId) {
      const node = definition.value.nodes[entryId]
      entry = {
        step: entryId,
        queue: node.function?.queue || 'default',
        engineRetryMax: node.function?.engine_retry?.max_attempts,
        workerId: node.function.id,
        runtime: node.function.runtime as 'nodejs' | 'python',
        runtype: (node as any).runtype || 'task',
        emits: (node as any).emits || [],
      }
    }
  }

  return {
    id: runId.value,
    entry,
    steps,
    analyzed,
  }
})

const stepNameBySpanId = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const span of timeline.value?.spans ?? []) {
    const attrs = normalizeTraceAttributes(span?.attributes)
    const stepName = attrs['workflow.node_uid'] || attrs['iii.function.id'] || span?.name
    if (span?.span_id && stepName) out[span.span_id] = String(stepName)
  }
  return out
})

const stepNameByTraceId = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const span of timeline.value?.spans ?? []) {
    const attrs = normalizeTraceAttributes(span?.attributes)
    const stepName = attrs['workflow.node_uid'] || attrs['iii.function.id'] || span?.name
    if (span?.trace_id && stepName && !out[span.trace_id]) out[span.trace_id] = String(stepName)
  }
  return out
})

const timelineEvents = computed(() => {
  const items: any[] = []
  const lifecycleKeys = new Set<string>()

  if (status.value?.created_at) {
    items.push({
      id: `flow-start-${status.value.created_at}`,
      ts: status.value.created_at,
      type: 'flow.start',
      data: {
        runId: runId.value,
        status: status.value.status,
      },
    })
  }

  if (normalizedStatus.value === 'completed' || normalizedStatus.value === 'failed') {
    items.push({
      id: `flow-terminal-${status.value?.updated_at || 0}`,
      ts: status.value?.updated_at,
      type: normalizedStatus.value === 'completed' ? 'flow.completed' : 'flow.failed',
      data: {
        runId: runId.value,
        status: normalizedStatus.value,
      },
    })
  }

  Object.entries(status.value?.nodes ?? {}).forEach(([id, checkpoint]: [string, any]) => {
    if (checkpoint.retries > 0) {
      items.push({
        id: `step-retry-${id}-${checkpoint.retries}`,
        ts: checkpoint.pending_at || status.value?.updated_at,
        type: 'step.retry',
        stepName: id,
        data: { retries: checkpoint.retries },
      })
    }
  })

  for (const span of timeline.value?.spans ?? []) {
    const attrs = normalizeTraceAttributes(span?.attributes)
    const stepName = attrs['workflow.node_uid'] || attrs['iii.function.id'] || span?.name
    const pending = Boolean(span?.pending || span?.end_time_unix_nano === 0)
    for (const event of span?.events ?? []) {
      const eventAttrs = normalizeTraceAttributes(event?.attributes)
      const eventName = String(event?.name || '')
      const eventStepName = eventAttrs['workflow.node_uid'] || eventAttrs['iii.function.id'] || stepName
      const eventTs = nanosToMs(event?.timestamp_unix_nano) || nanosToMs(span?.start_time_unix_nano)

      let eventType: string | null = null
      if (eventName === 'workflow.node.started') eventType = 'step.started'
      else if (eventName === 'workflow.node.completed') eventType = 'step.completed'
      else if (eventName === 'workflow.node.failed') eventType = 'step.failed'
      else if (eventName === 'workflow.state.set') eventType = 'state.set'
      else if (eventName === 'workflow.state.delete') eventType = 'state.delete'
      else if (eventName === 'workflow.stream.publish' || eventName === 'workflow.stream.set') eventType = 'stream.publish'
      else if (eventName === 'workflow.stream.delete') eventType = 'stream.delete'

      if (!eventType || !eventStepName) continue
      lifecycleKeys.add(`${eventStepName}:${eventType}`)
      items.push({
        id: `span-event-${span?.span_id || 'unknown'}-${eventName}-${eventTs}`,
        ts: eventTs,
        type: eventType,
        stepName: String(eventStepName),
        data: {
          name: span?.name,
          pending,
          spanId: span?.span_id,
          status: span?.status,
          traceId: span?.trace_id,
          key: eventAttrs['workflow.state.key'],
          value: eventAttrs['workflow.state.value'],
          ...attrs,
          ...eventAttrs,
        },
      })
    }

    if (pending && stepName && !lifecycleKeys.has(`${stepName}:step.started`)) {
      items.push({
        id: `span-pending-${span?.span_id || stepName}`,
        ts: nanosToMs(span?.start_time_unix_nano) || status.value?.updated_at || Date.now(),
        type: 'step.running',
        stepName: String(stepName),
        data: {
          name: span?.name,
          pending,
          spanId: span?.span_id,
          status: span?.status,
          traceId: span?.trace_id,
          ...attrs,
        },
      })
    }
  }

  Object.entries(status.value?.nodes ?? {}).forEach(([id, checkpoint]: [string, any]) => {
    if (checkpoint.pending_at && !lifecycleKeys.has(`${id}:step.started`)) {
      items.push({
        id: `step-running-${id}-${checkpoint.pending_at}`,
        ts: checkpoint.pending_at,
        type: checkpoint.state === 'running' ? 'step.running' : 'step.started',
        stepName: id,
        data: {
          state: checkpoint.state,
          retries: checkpoint.retries,
          workerName: checkpoint.worker_name,
        },
      })
    }

    if (checkpoint.completed_at && !lifecycleKeys.has(`${id}:${checkpoint.result_error ? 'step.failed' : 'step.completed'}`)) {
      items.push({
        id: `step-completed-${id}-${checkpoint.completed_at}`,
        ts: checkpoint.completed_at,
        type: checkpoint.result_error ? 'step.failed' : 'step.completed',
        stepName: id,
        data: {
          error: checkpoint.result_error,
          retries: checkpoint.retries,
          workerName: checkpoint.worker_name,
        },
      })
    }

    if (checkpoint.result_error && !checkpoint.completed_at && !lifecycleKeys.has(`${id}:step.failed`)) {
      items.push({
        id: `step-error-${id}-${checkpoint.pending_at || status.value?.updated_at || 0}`,
        ts: checkpoint.pending_at || status.value?.updated_at,
        type: 'step.failed',
        stepName: id,
        data: {
          error: checkpoint.result_error,
          retries: checkpoint.retries,
          workerName: checkpoint.worker_name,
        }
      })
    }
  })

  items.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
  return items.slice(0, 100)
})

const timelineLogs = computed(() => {
  return (timeline.value?.logs ?? []).map((log: any) => {
    const nestedLogData = log?.attributes?.['log.data'] || {}
    const systemKeys = new Set([
      'level',
      'trace_id',
      'span_id',
      'workflow.run_id',
      'workflow.node_uid',
      'iii.function.id',
      'workflow.runtime',
    ])
    const metadata = Object.fromEntries(
      Object.entries(nestedLogData).filter(([key]) => !systemKeys.has(key)),
    )

    const traceId = log?.trace_id || nestedLogData?.trace_id
    const spanId = log?.span_id || nestedLogData?.span_id

    const stepName = log?.attributes?.['workflow.node_uid']
      || nestedLogData?.['workflow.node_uid']
      || stepNameBySpanId.value[spanId]
      || stepNameByTraceId.value[traceId]
      || log?.attributes?.['iii.function.id']
      || nestedLogData?.['iii.function.id']

    const level = String(nestedLogData?.level || log?.severity_text || 'INFO').toLowerCase()
    const message = String(log?.body || '')

    return {
      id: `log-${log?.timestamp_unix_nano}-${log?.span_id || ''}`,
      ts: nanosToMs(log?.timestamp_unix_nano),
      type: 'log',
      stepName,
      level,
      message,
      data: {
        level,
        message,
        serviceName: log?.service_name,
        traceId,
        spanId,
        metadata,
        workflow: {
          runId: log?.attributes?.['workflow.run_id'] || nestedLogData?.['workflow.run_id'],
          nodeUid: log?.attributes?.['workflow.node_uid'] || nestedLogData?.['workflow.node_uid'],
          functionId: log?.attributes?.['iii.function.id'] || nestedLogData?.['iii.function.id'],
          runtime: log?.attributes?.['workflow.runtime'] || nestedLogData?.['workflow.runtime'],
        },
      },
    }
  })
})

const timelineStates = computed(() => {
  return (workflowStates.value?.states ?? []).map((item: any) => ({
    id: `state-${item.id || `${item.key}-${item.ts_unix_ms || 0}`}`,
    ts: Number(item.ts_unix_ms || 0),
    type: item.kind === 'delete' ? 'state.delete' : 'state.set',
    stepName: item.node_uid || item.function_id,
    data: {
      key: item.key,
      value: item.value,
      nodeUid: item.node_uid,
      functionId: item.function_id,
      runId: item.run_id,
    },
  }))
})

const timelineStreams = computed(() => {
  return timelineEvents.value
    .filter(item => item.type === 'stream.publish' || item.type === 'stream.delete')
    .map((item: any, index: number) => ({
      id: item.id || `stream-${item.data?.streamName || item.data?.['workflow.stream.name'] || index}`,
      ts: item.ts,
      type: item.type,
      stepName: item.stepName,
      data: {
        streamName: String(item.data?.streamName || item.data?.['workflow.stream.name'] || ''),
        itemId: item.data?.itemId || item.data?.['workflow.stream.item_id'],
        nodeUid: item.stepName || item.data?.nodeUid || item.data?.['workflow.node_uid'],
        functionId: item.data?.functionId || item.data?.['iii.function.id'],
        preview: item.data?.preview || item.data?.['workflow.stream.preview'],
        eventName: item.type,
        runId: runId.value,
      },
    }))
})

const stepStates = computed(() => {
  const out: Record<string, any> = {}
  Object.entries(status.value?.nodes ?? {}).forEach(([id, nodeStatus]: [string, any]) => {
    let uiStatus = nodeStatus.state || nodeStatus
    if (typeof uiStatus === 'string') {
      if (uiStatus === 'done') uiStatus = 'completed'
      else if (uiStatus === 'error' || uiStatus === 'failed') uiStatus = 'failed'
      else if (uiStatus === 'active' || uiStatus === 'queued' || uiStatus === 'running') uiStatus = 'running'
    }

    out[id] = {
      status: uiStatus,
      error: nodeStatus.result_error,
      result: nodeStatus.result_ref,
      pending_at: nodeStatus.pending_at,
      completed_at: nodeStatus.completed_at,
      worker_name: nodeStatus.worker_name,
      retries: nodeStatus.retries,
    }
  })
  return out
})

const stepList = computed(() => {
  if (!definition.value?.nodes) return []

  return sortNodesByLevel(definition.value.nodes).map(id => {
    const state = stepStates.value[id]
    return {
      key: id,
      status: state?.status || 'idle',
      error: state?.error,
      result: state?.result,
      retries: state?.retries,
    }
  })
})

const selectedStep = ref<string | null>(null)

const filteredTimelineEvents = computed(() => {
  if (!selectedStep.value) return timelineEvents.value

  return timelineEvents.value.filter((item: any) => {
    if (!item.stepName) {
      return item.type === 'flow.start' || item.type === 'flow.completed' || item.type === 'flow.failed'
    }
    return item.stepName === selectedStep.value
  })
})

const filteredTimelineLogs = computed(() => {
  if (!selectedStep.value) return timelineLogs.value
  return timelineLogs.value.filter((item: any) => item.stepName === selectedStep.value)
})

const filteredTimelineStates = computed(() => {
  if (!selectedStep.value) return timelineStates.value
  return timelineStates.value.filter((item: any) => item.stepName === selectedStep.value)
})

const filteredTimelineStreams = computed(() => {
  if (!selectedStep.value) return timelineStreams.value
  return timelineStreams.value.filter((item: any) => item.stepName === selectedStep.value)
})

async function refreshAll() {
  await Promise.all([refresh(), refreshTimeline()])
}

async function openStateSlideover() {
  isStateSlideoverOpen.value = true
  await refreshStates()
}

async function openStreamSlideover() {
  isStreamSlideoverOpen.value = true
  await refreshStreams()
}

const filteredWorkflowStates = computed(() => {
  return workflowStates.value?.states ?? []
})

function exportStates() {
  const data = filteredWorkflowStates.value
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `workflow-states-${runId.value}-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-950">
    <!-- Header -->
    <div class="border-b border-zinc-200 dark:border-zinc-800 px-6 py-4 shrink-0 bg-white dark:bg-zinc-950">
      <div class="flex items-center justify-between w-full">
        <div class="flex items-center gap-4">
          <UButton
            icon="i-heroicons-chevron-left"
            color="gray"
            variant="ghost"
            @click="push(`/workflows/runs`)"
          />
          <div>
            <h1 class="text-xl font-bold text-zinc-900 dark:text-white flex items-center gap-2">
              Run: <span class="font-mono text-lg opacity-70">{{ (runId || '').slice(0, 8) }}...</span>
            </h1>
            <p class="text-xs text-zinc-500 dark:text-zinc-400">Execution detail and node status</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <!-- State Slideover -->
          <USlideover 
            v-model="isStateSlideoverOpen"
            title="State Inspector">
            <UButton
              icon="i-lucide-database"
              color="neutral"
              variant="outline"
              label="State"
              @click="openStateSlideover"
            />
            <template #content>
              <NventFlowStateInspector
                :states="filteredWorkflowStates"
                :is-loading="statesPending"
                :error-message="statesError ? 'State data could not be loaded' : null"
                :is-live="normalizedStatus === 'running' || normalizedStatus === 'awaiting' || normalizedStatus === 'awaiting_nodes'"
                @export="exportStates"
              />
            </template>
          </USlideover>

          <!-- Stream Slideover -->
          <USlideover
            v-model="isStreamSlideoverOpen"
            title="Stream Inspector">
            <UButton
              icon="i-lucide-waves"
              color="neutral"
              variant="outline"
              label="Streams"
              @click="openStreamSlideover"
            />
            <template #content>
              <NventFlowStreamInspector
                :streams="workflowStreamRefs"
                :is-loading="streamsPending"
                :error-message="streamsError ? 'Stream references could not be loaded' : null"
                :is-live="normalizedStatus === 'running' || normalizedStatus === 'awaiting' || normalizedStatus === 'awaiting_nodes'"
              />
            </template>
          </USlideover>
           <UBadge
             v-if="normalizedStatus"
             :label="normalizedStatus.toUpperCase()"
             size="lg"
             :color="normalizedStatus === 'completed' ? 'success' : normalizedStatus === 'failed' ? 'error' : 'neutral'"
             variant="outline"
           />
           <UButton
             icon="i-heroicons-arrow-path"
             color="neutral"
             variant="outline"
             :loading="pending"
             @click="refreshAll"
           />
        </div>
      </div>
    </div>

    <div class="flex-1 overflow-hidden">
      <div class="h-full flex flex-col xl:flex-row overflow-hidden">
        <div class="min-w-0 flex-1 relative overflow-hidden border-b xl:border-b-0 xl:border-r border-zinc-200 dark:border-zinc-800">
        <div v-if="pending && !status" class="absolute inset-0 flex items-center justify-center bg-white/50 z-10 dark:bg-zinc-900/50">
           <div class="w-10 h-10 border-4 border-zinc-200 border-t-zinc-800 rounded-full animate-spin"></div>
        </div>
        
        <div v-else-if="error" class="p-12 text-center">
          <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/20 text-red-600 mb-4">
             <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <p class="text-red-500 font-medium">Failed to load run status</p>
          <p class="text-sm text-zinc-500 mt-2">{{ error }}</p>
        </div>

        <div v-else class="h-full w-full">
          <NventFlowDiagram 
            v-if="flowMeta"
            height-class="h-full"
            :show-controls="true"
            :show-background="true"
            :flow="flowMeta"
            :step-states="stepStates"
            :flow-status="normalizedStatus"
          />
          <div v-else class="h-full flex items-center justify-center text-zinc-500">
             No diagram data available
          </div>
        </div>
        </div>

        <div class="w-full xl:w-[24rem] 2xl:w-[26rem] shrink-0 bg-white dark:bg-zinc-950 flex flex-col overflow-hidden border-b xl:border-b-0 xl:border-r border-zinc-200 dark:border-zinc-800">
          <NventFlowRunOverview
            v-if="status"
            :run-status="normalizedStatus"
            :run-id="runId"
            :steps="stepList"
            :started-at="status.created_at"
            :completed-at="status.updated_at"
            :result="status.result"
            :flow-def="flowMeta"
            @select-step="selectedStep = $event"
            @cancel-flow="() => {}"
            @restart-flow="() => {}"
          />
          <div v-else-if="pending" class="p-8 space-y-4">
            <div class="h-8 bg-zinc-100 dark:bg-zinc-800 rounded animate-pulse w-1/2"></div>
            <div class="h-32 bg-zinc-100 dark:bg-zinc-800 rounded animate-pulse"></div>
            <div class="space-y-2">
              <div class="h-10 bg-zinc-100 dark:bg-zinc-800 rounded animate-pulse"></div>
              <div class="h-10 bg-zinc-100 dark:bg-zinc-800 rounded animate-pulse"></div>
            </div>
          </div>
        </div>

        <div class="w-full xl:w-[28rem] 2xl:w-[32rem] shrink-0 bg-white dark:bg-zinc-950 flex flex-col overflow-hidden">
          <NventFlowRunTimeline
            :events="filteredTimelineEvents"
            :logs="filteredTimelineLogs"
            :states="filteredTimelineStates"
            :streams="filteredTimelineStreams"
            :timeline-loading="timelinePending"
            :timeline-error="timelineError"
            :selected-step="selectedStep"
            :is-live="normalizedStatus === 'running' || normalizedStatus === 'awaiting' || normalizedStatus === 'awaiting_nodes'"
          />
        </div>
      </div>
    </div>
  </div>
</template>
