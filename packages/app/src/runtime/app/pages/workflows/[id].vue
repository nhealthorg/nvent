<script setup lang="ts">
import { computed, ref, useComponentRouter, onMounted, onUnmounted, watch } from '#imports'
import type { Ref } from 'vue'
import { useWorkflowAnalysis } from '../../composables/useWorkflowAnalysis'

const { sortNodesByLevel, analyzeWorkflow } = useWorkflowAnalysis()
const { push, route } = useComponentRouter()

const props = defineProps<{
  runId?: string
}>()

const runId = computed(() => props.runId || (route.value.params.id as string))

const isStateSlideoverOpen = ref(false)
const isStreamSlideoverOpen = ref(false)
const isCancelSlideoverOpen = ref(false)
const isDeleteModalOpen = ref(false)
const cancelPending = ref(false)
const cancelError = ref<string | null>(null)
const cancelResult = ref<WorkflowStopResponse | null>(null)
const deletePending = ref(false)
const deleteError = ref<string | null>(null)

interface WorkflowRunStatusResponse {
  status: string
  definition: any
  nodes: Record<string, any>
  loop_stats?: Record<string, {
    mode: 'parallel' | 'sequential' | string
    over: string
    expanded: boolean
    total_items: number
    completed_items: number
    running_items: number
    failed_items: number
    cancelled_items: number
    pending_items: number
    active_index?: number | null
  }>
  created_at: number
  updated_at: number
  queue_receipts?: Array<{
    run_id: string
    node_uid: string
    queue: string
    receipt_id: string
    enqueued_at?: number
  }>
  result?: any
  result_error?: string
}

interface WorkflowStopResponse {
  stopping: boolean
  stopped_sessions?: number
  queue_fragments_detected?: number
  checked_queues?: string[]
  tracked_receipt_count?: number
  tracked_receipt_ids?: string[]
  queue_cleanup_attempted?: number
  queue_cleanup_succeeded?: number
  queue_cleanup_errors?: Record<string, string>
}

interface WorkflowNodeResultResponse {
  node_uid: string
  result: unknown
}

interface UseWorkflowRunDetailResult {
  status: Ref<WorkflowRunStatusResponse | null>
  statusPending: Ref<boolean>
  statusError: Ref<unknown>
  refreshStatus: (options?: { silent?: boolean }) => Promise<void>
  refreshAll: () => Promise<void>
}

function useWorkflowRunDetail(runIdRef: Ref<string>): UseWorkflowRunDetailResult {
  const status = ref<WorkflowRunStatusResponse | null>(null)
  const statusPending = ref(false)
  const statusError = ref<unknown>(null)
  let inFlight: Promise<void> | null = null

  async function refreshStatus(options?: { silent?: boolean }) {
    if (inFlight) {
      await inFlight
      return
    }

    const silent = Boolean(options?.silent)
    const run = async () => {
      if (!silent) {
        statusPending.value = true
      }
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
        if (!silent) {
          statusPending.value = false
        }
      }
    }

    inFlight = run()
    try {
      await inFlight
    } finally {
      inFlight = null
    }
  }

  async function refreshAll() {
    await refreshStatus()
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
    refreshAll,
  }
}

const {
  status,
  statusPending: pending,
  statusError: error,
  refreshStatus: refresh,
  refreshAll: refreshAllData,
} = useWorkflowRunDetail(runId)

const definition = computed(() => status.value?.definition)

let refreshInterval: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  refreshInterval = setInterval(() => {
    if (status.value?.status === 'running' || status.value?.status === 'awaiting_nodes' || status.value?.status === 'awaiting') {
      refresh({ silent: true })
    }
  }, 1000)
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

type LoopGroupInfo = {
  id: string
  mode: 'parallel' | 'sequential'
  over: string
  nodeIds: string[]
  label: string
}

function topoSortSubset(nodeIds: string[], nodeDefs: Record<string, any>, fallbackOrder: string[]): string[] {
  const subset = new Set(nodeIds)
  const indegree = new Map<string, number>()
  const forward = new Map<string, string[]>()

  for (const id of nodeIds) {
    indegree.set(id, 0)
    forward.set(id, [])
  }

  for (const id of nodeIds) {
    const deps = Array.isArray(nodeDefs[id]?.depends_on) ? nodeDefs[id].depends_on : []
    for (const dep of deps) {
      if (!subset.has(dep)) continue
      forward.get(dep)?.push(id)
      indegree.set(id, (indegree.get(id) || 0) + 1)
    }
  }

  const rank = new Map<string, number>()
  fallbackOrder.forEach((id, idx) => rank.set(id, idx))

  const ready: string[] = nodeIds.filter(id => (indegree.get(id) || 0) === 0)
  ready.sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER))

  const out: string[] = []
  while (ready.length > 0) {
    const id = ready.shift()!
    out.push(id)
    for (const nextId of forward.get(id) || []) {
      indegree.set(nextId, (indegree.get(nextId) || 0) - 1)
      if ((indegree.get(nextId) || 0) === 0) {
        ready.push(nextId)
      }
    }
    ready.sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER))
  }

  if (out.length === nodeIds.length) return out
  return [...nodeIds].sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER))
}

const loopGroups = computed<{
  groups: LoopGroupInfo[]
  byNodeId: Record<string, LoopGroupInfo>
}>(() => {
  const nodeDefs: Record<string, any> = definition.value?.nodes || {}
  const nodeIds = Object.keys(nodeDefs)
  if (nodeIds.length === 0) return { groups: [], byNodeId: {} }

  const fallbackOrder = sortNodesByLevel(nodeDefs)
  const loopNodeIds = nodeIds.filter((id) => Boolean(nodeDefs[id]?.fanout))
  if (loopNodeIds.length === 0) return { groups: [], byNodeId: {} }

  const sigByNode = new Map<string, string>()
  for (const id of loopNodeIds) {
    const fanout = nodeDefs[id]?.fanout || {}
    const over = String(fanout.over || '')
    const mode = fanout.mode === 'sequential' ? 'sequential' : 'parallel'
    sigByNode.set(id, `${over}::${mode}`)
  }

  const adjacency = new Map<string, Set<string>>()
  for (const id of loopNodeIds) adjacency.set(id, new Set())

  for (const id of loopNodeIds) {
    const deps = Array.isArray(nodeDefs[id]?.depends_on) ? nodeDefs[id].depends_on : []
    for (const dep of deps) {
      if (!adjacency.has(dep)) continue
      if (sigByNode.get(id) !== sigByNode.get(dep)) continue
      adjacency.get(id)?.add(dep)
      adjacency.get(dep)?.add(id)
    }
  }

  const visited = new Set<string>()
  const components: string[][] = []

  for (const start of loopNodeIds) {
    if (visited.has(start)) continue
    const queue = [start]
    visited.add(start)
    const component: string[] = []

    while (queue.length > 0) {
      const id = queue.shift()!
      component.push(id)
      for (const nextId of adjacency.get(id) || []) {
        if (visited.has(nextId)) continue
        visited.add(nextId)
        queue.push(nextId)
      }
    }

    components.push(component)
  }

  const groups: LoopGroupInfo[] = components
    .map((component, index) => {
      const first = component[0]
      if (!first) return null
      const fanout = nodeDefs[first]?.fanout || {}
      const mode: 'parallel' | 'sequential' = fanout.mode === 'sequential' ? 'sequential' : 'parallel'
      const over = String(fanout.over || '')
      const orderedNodes = topoSortSubset(component, nodeDefs, fallbackOrder)
      return {
        id: `loop-${index + 1}`,
        mode,
        over,
        nodeIds: orderedNodes,
        label: orderedNodes.join(' -> '),
      }
    })
    .filter((group): group is LoopGroupInfo => Boolean(group))
    .sort((a, b) => {
      const firstA = fallbackOrder.indexOf(a.nodeIds[0] || '')
      const firstB = fallbackOrder.indexOf(b.nodeIds[0] || '')
      return firstA - firstB
    })

  const byNodeId: Record<string, LoopGroupInfo> = {}
  for (const group of groups) {
    for (const nodeId of group.nodeIds) {
      byNodeId[nodeId] = group
    }
  }

  return { groups, byNodeId }
})

const flowMeta = computed(() => {
  if (!definition.value?.nodes) return null

  const analyzed = analyzeWorkflow(definition.value.nodes)
  const steps: Record<string, any> = {}

  Object.entries(definition.value.nodes).forEach(([id, node]: [string, any]) => {
    const loopGroup = loopGroups.value.byNodeId[id]
    steps[id] = {
      name: id,
      label: node.label,
      workerId: node.function?.id,
      runtime: node.function?.runtime,
      dependsOn: node.depends_on || [],
      queue: node.function?.queue || 'default',
      engineRetryMax: node.function?.engine_retry?.max_attempts,
      runtype: (node as any).runtype || 'task',
      emits: (node as any).emits || [],
      isLoop: Boolean(loopGroup),
      loopOver: loopGroup?.over,
      loopMode: loopGroup?.mode || 'parallel',
      loopGroupId: loopGroup?.id,
      loopGroupSize: loopGroup?.nodeIds.length || 0,
      loopPipeline: loopGroup?.label,
    }
  })

  let entry
  if (analyzed.levels[0]?.length === 1) {
    const entryId = analyzed.levels[0][0]
    if (entryId) {
      const node = definition.value.nodes[entryId]
      entry = {
        step: entryId,
        label: node.label,
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
    loopGroups: loopGroups.value.groups,
    analyzed,
  }
})

const stepStates = computed(() => {
  const out: Record<string, any> = {}
  const nodeStates = status.value?.nodes ?? {}

  Object.entries(nodeStates).forEach(([id, nodeStatus]: [string, any]) => {
    let uiStatus = nodeStatus.state || nodeStatus
    if (typeof uiStatus === 'string') {
      if (uiStatus === 'done') uiStatus = 'completed'
      else if (uiStatus === 'error' || uiStatus === 'failed') uiStatus = 'failed'
      else if (uiStatus === 'cancelled' || uiStatus === 'canceled') uiStatus = 'canceled'
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

  // For fanout/loop nodes, aggregate child `node#i` checkpoints into the base step
  // so overview and diagram show one logical loop step state.
  Object.entries(definition.value?.nodes ?? {}).forEach(([baseId, nodeDef]: [string, any]) => {
    if (!nodeDef?.fanout) return

    const children = Object.entries(nodeStates).filter(([id]) => id.startsWith(`${baseId}#`))
    if (children.length === 0) return

    const childStates = children.map(([, cp]: any) => String(cp?.state || '').toLowerCase())
    const childErrors = children
      .map(([, cp]: any) => cp?.result_error)
      .filter((msg: any) => typeof msg === 'string' && msg.length > 0)
    const retries = children.reduce((sum, [, cp]: any) => sum + Number(cp?.retries || 0), 0)

    let aggregated: 'running' | 'completed' | 'failed' | 'canceled' | 'idle' = 'idle'
    if (childStates.some(s => s === 'failed' || s === 'error')) aggregated = 'failed'
    else if (childStates.some(s => s === 'running' || s === 'active' || s === 'queued' || s === 'pending')) aggregated = 'running'
    else if (childStates.some(s => s === 'cancelled' || s === 'canceled')) aggregated = 'canceled'
    else if (childStates.length > 0 && childStates.every(s => s === 'done' || s === 'completed')) aggregated = 'completed'

    const childPending = children
      .map(([, cp]: any) => Number(cp?.pending_at || 0))
      .filter(v => v > 0)
    const childCompleted = children
      .map(([, cp]: any) => Number(cp?.completed_at || 0))
      .filter(v => v > 0)

    out[baseId] = {
      ...(out[baseId] || {}),
      status: aggregated,
      retries,
      error: childErrors[0],
      pending_at: childPending.length > 0 ? Math.min(...childPending) : out[baseId]?.pending_at,
      completed_at: childCompleted.length > 0 ? Math.max(...childCompleted) : out[baseId]?.completed_at,
    }
  })

  return out
})

const stepList = computed(() => {
  if (!definition.value?.nodes) return []

  const ordered = sortNodesByLevel(definition.value.nodes)
  const nodeStates = status.value?.nodes ?? {}
  const groupsById = Object.fromEntries(loopGroups.value.groups.map(group => [group.id, group])) as Record<string, LoopGroupInfo>
  const insertedGroups = new Set<string>()
  const out: any[] = []

  for (const id of ordered) {
    const state = stepStates.value[id]
    const node = definition.value.nodes[id]
    const group = loopGroups.value.byNodeId[id]

    if (group && !insertedGroups.has(group.id)) {
      const groupLoopNodeStats = group.nodeIds
        .map(memberId => status.value?.loop_stats?.[memberId])
        .filter(Boolean) as Array<NonNullable<WorkflowRunStatusResponse['loop_stats']>[string]>

      const totalItems = groupLoopNodeStats.reduce((max, entry) => Math.max(max, Number(entry.total_items || 0)), 0)
      const completedItems = groupLoopNodeStats.reduce((min, entry) => {
        const value = Number(entry.completed_items || 0)
        return min === null ? value : Math.min(min, value)
      }, null as number | null) ?? 0
      const runningItems = groupLoopNodeStats.reduce((sum, entry) => sum + Number(entry.running_items || 0), 0)
      const failedItems = groupLoopNodeStats.reduce((sum, entry) => sum + Number(entry.failed_items || 0), 0)
      const pendingItems = groupLoopNodeStats.reduce((sum, entry) => sum + Number(entry.pending_items || 0), 0)
      const activeIndexCandidates = groupLoopNodeStats
        .map(entry => Number(entry.active_index))
        .filter(v => Number.isFinite(v) && v >= 0)
      const activeIndex = activeIndexCandidates.length > 0 ? Math.min(...activeIndexCandidates) : null

      const memberStates = group.nodeIds
        .map(memberId => stepStates.value[memberId])
        .filter(Boolean)
      const statuses = memberStates.map((memberState: any) => String(memberState?.status || '').toLowerCase())
      const loopResultCount = Object.entries(nodeStates)
        .filter(([uid, cp]: [string, any]) => {
          const base = uid.split('#')[0]
          return group.nodeIds.includes(base || '') && Boolean(cp?.result_ref)
        })
        .length

      let groupStatus = 'idle'
      if (statuses.some(s => s === 'failed' || s === 'error')) groupStatus = 'failed'
      else if (statuses.some(s => s === 'running' || s === 'queued' || s === 'active' || s === 'pending')) groupStatus = 'running'
      else if (statuses.length > 0 && statuses.every(s => s === 'completed' || s === 'done')) groupStatus = 'completed'

      const groupRetries = memberStates.reduce((sum: number, memberState: any) => sum + Number(memberState?.retries || 0), 0)

      out.push({
        key: `loop-group:${group.id}`,
        status: groupStatus,
        retries: groupRetries,
        isLoopGroup: true,
        loopGroupId: group.id,
        loopOver: group.over,
        loopMode: group.mode,
        loopPipeline: group.label,
        loopSize: group.nodeIds.length,
        loopItemsTotal: totalItems,
        loopItemsDone: completedItems,
        loopItemsRunning: runningItems,
        loopItemsFailed: failedItems,
        loopItemsPending: pendingItems,
        loopActiveIndex: activeIndex,
        canInspectResult: loopResultCount > 0,
      })
      insertedGroups.add(group.id)
    }

    const loopChildResultUids = Object.entries(nodeStates)
      .filter(([uid, cp]: [string, any]) => uid.startsWith(`${id}#`) && Boolean(cp?.result_ref))
      .map(([uid]) => uid)

    out.push({
      key: id,
      label: node?.label,
      status: state?.status || 'idle',
      error: state?.error,
      result: state?.result,
      retries: state?.retries,
      isLoop: false,
      loopOver: group?.over,
      loopMode: group?.mode || 'parallel',
      loopGroupId: group?.id,
      loopSize: group?.nodeIds.length || 0,
      loopPipeline: groupsById[group?.id || '']?.label,
      inLoopGroup: Boolean(group),
      isLoopLeader: Boolean(group?.nodeIds[0] === id),
      functionId: node?.function?.id,
      isVarStep: node?.function?.id === 'workflow::internal-var-set',
      canInspectResult: Boolean(state?.result) || loopChildResultUids.length > 0,
      loopChildResultUids,
    })
  }

  return out
})

const selectedStep = ref<string | null>(null)
const isResultSlideoverOpen = ref(false)
const selectedResultStepKey = ref<string | null>(null)
const selectedResultNodeUid = ref<string | null>(null)
const resultNodeUidOptions = ref<string[]>([])
const resultPending = ref(false)
const resultError = ref<string | null>(null)
const selectedNodeResult = ref<unknown>(null)

function baseStepName(stepName?: string | null): string | null {
  if (!stepName) return null
  return String(stepName).split('#')[0] || null
}

const loopGroupNodeIdsByKey = computed<Record<string, string[]>>(() => {
  const map: Record<string, string[]> = {}
  for (const group of loopGroups.value.groups) {
    map[`loop-group:${group.id}`] = group.nodeIds
  }
  return map
})

const selectedStepNodeIds = computed<string[]>(() => {
  const current = selectedStep.value
  if (!current || !current.startsWith('loop-group:')) return []
  return loopGroupNodeIdsByKey.value[current] || []
})

function stepMatchesSelection(stepName: string | null | undefined, selection: string | null): boolean {
  if (!selection) return true
  const base = baseStepName(stepName)
  if (!base) return false

  if (selection.startsWith('loop-group:')) {
    const members = loopGroupNodeIdsByKey.value[selection] || []
    return members.includes(base)
  }

  return base === selection
}

function candidateResultUidsForStep(stepKey: string): string[] {
  const nodeStates = status.value?.nodes ?? {}

  if (stepKey.startsWith('loop-group:')) {
    const members = loopGroupNodeIdsByKey.value[stepKey] || []
    return Object.entries(nodeStates)
      .filter(([uid, cp]: [string, any]) => {
        const base = uid.split('#')[0]
        return members.includes(base || '') && Boolean(cp?.result_ref)
      })
      .map(([uid]) => uid)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }

  const direct = nodeStates[stepKey]
  if (direct?.result_ref) return [stepKey]

  return Object.entries(nodeStates)
    .filter(([uid, cp]: [string, any]) => uid.startsWith(`${stepKey}#`) && Boolean(cp?.result_ref))
    .map(([uid]) => uid)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

async function fetchNodeResult(nodeUid: string) {
  resultPending.value = true
  resultError.value = null
  try {
    const response = await $fetch<WorkflowNodeResultResponse>('/api/_workflows/node-result', {
      params: {
        run_id: runId.value,
        node_uid: nodeUid,
      },
    })
    selectedNodeResult.value = response?.result ?? null
  }
  catch (error: any) {
    resultError.value = error?.data?.statusMessage || error?.message || 'Result loading failed'
    selectedNodeResult.value = null
  }
  finally {
    resultPending.value = false
  }
}

async function openResultSlideover(stepKey: string) {
  selectedResultStepKey.value = stepKey
  resultNodeUidOptions.value = candidateResultUidsForStep(stepKey)
  selectedResultNodeUid.value = resultNodeUidOptions.value[0] || null
  selectedNodeResult.value = null
  resultError.value = null
  isResultSlideoverOpen.value = true

  if (selectedResultNodeUid.value) {
    await fetchNodeResult(selectedResultNodeUid.value)
  }
}

watch(selectedResultNodeUid, (nextUid, prevUid) => {
  if (!isResultSlideoverOpen.value) return
  if (!nextUid || nextUid === prevUid) return
  void fetchNodeResult(nextUid)
})

async function refreshAll() {
  await refresh()
}

async function openStateSlideover() {
  isStateSlideoverOpen.value = true
}

async function openStreamSlideover() {
  isStreamSlideoverOpen.value = true
}

function openCancelSlideover() {
  isCancelSlideoverOpen.value = true
}

function openDeleteModal() {
  if (!isRunTerminal.value || deletePending.value) return
  deleteError.value = null
  isDeleteModalOpen.value = true
}

async function confirmDeleteRun() {
  if (!isRunTerminal.value || deletePending.value) return

  deletePending.value = true
  deleteError.value = null
  try {
    await $fetch('/api/_workflows/delete', {
      method: 'POST',
      body: { run_id: runId.value },
    })
    isDeleteModalOpen.value = false
    await push('/workflows/runs')
  }
  catch (error: any) {
    deleteError.value = error?.data?.statusMessage || error?.message || 'Delete failed'
  }
  finally {
    deletePending.value = false
  }
}

async function cancelRun() {
  cancelPending.value = true
  cancelError.value = null
  try {
    cancelResult.value = await $fetch<WorkflowStopResponse>('/api/_workflows/stop', {
      method: 'POST',
      body: { run_id: runId.value },
    })
    await refreshAll()
  }
  catch (error: any) {
    cancelError.value = error?.data?.statusMessage || error?.message || 'Cancel failed'
  }
  finally {
    cancelPending.value = false
  }
}

const cancelCleanupAttempted = computed(() => cancelResult.value?.queue_cleanup_attempted ?? 0)
const cancelCleanupSucceeded = computed(() => cancelResult.value?.queue_cleanup_succeeded ?? 0)
const cancelCleanupErrors = computed(() => cancelResult.value?.queue_cleanup_errors ?? {})
const cancelCleanupErrorEntries = computed(() => Object.entries(cancelCleanupErrors.value))
const cancelCleanupHasErrors = computed(() => cancelCleanupErrorEntries.value.length > 0)
const cancelCleanupRate = computed(() => {
  const attempted = cancelCleanupAttempted.value
  if (attempted <= 0) return 100
  return Math.round((cancelCleanupSucceeded.value / attempted) * 100)
})
const cancelCheckedQueues = computed(() => cancelResult.value?.checked_queues ?? [])
const cancelTrackedReceiptIds = computed(() => cancelResult.value?.tracked_receipt_ids ?? [])
const isRunCancelled = computed(() => normalizedStatus.value === 'cancelled')
const isRunTerminal = computed(() => {
  const current = String(normalizedStatus.value || '')
  return current === 'completed' || current === 'failed' || current === 'cancelled'
})
const showCancelAction = computed(() => !isRunTerminal.value)
const cancelDisplay = computed(() => ({
  stopped_sessions: cancelResult.value?.stopped_sessions ?? 0,
  queue_fragments_detected: cancelResult.value?.queue_fragments_detected ?? 0,
  tracked_receipt_count: cancelResult.value?.tracked_receipt_count ?? 0,
}))

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

const runDurationMs = computed(() => {
  const createdAt = Number(status.value?.created_at || 0)
  const updatedAt = Number(status.value?.updated_at || 0)
  if (createdAt <= 0 || updatedAt <= 0) return 0
  return Math.max(0, updatedAt - createdAt)
})
const runDurationLabel = computed(() => formatDurationMs(runDurationMs.value))

const nodeStats = computed(() => {
  const nodes = Object.values(status.value?.nodes ?? {}) as any[]
  const stats = {
    total: nodes.length,
    completed: 0,
    failed: 0,
    running: 0,
    cancelled: 0,
    waiting: 0,
    retries: 0,
  }

  for (const node of nodes) {
    const stateRaw = String(node?.state || '').toLowerCase()
    if (stateRaw === 'done' || stateRaw === 'completed') stats.completed += 1
    else if (stateRaw === 'error' || stateRaw === 'failed') stats.failed += 1
    else if (stateRaw === 'cancelled' || stateRaw === 'canceled') stats.cancelled += 1
    else if (stateRaw === 'running' || stateRaw === 'active' || stateRaw === 'queued') stats.running += 1
    else stats.waiting += 1

    const retries = Number(node?.retries || 0)
    if (Number.isFinite(retries) && retries > 0) stats.retries += retries
  }

  return stats
})

const statusQueueReceipts = computed(() => status.value?.queue_receipts ?? [])
const statusQueueReceiptCount = computed(() => statusQueueReceipts.value.length)
const statusQueueReceiptQueueCount = computed(() => new Set(statusQueueReceipts.value.map(item => item.queue)).size)
const statusQueueReceiptNodeCount = computed(() => new Set(statusQueueReceipts.value.map(item => item.node_uid)).size)

const loopOverviewStats = computed(() => {
  const loopStats = status.value?.loop_stats || {}
  const values = Object.values(loopStats)
  const loops = values.length
  const expandedLoops = values.filter(item => Boolean(item?.expanded)).length
  const totalItems = values.reduce((sum, item) => sum + Number(item?.total_items || 0), 0)
  const completedItems = values.reduce((sum, item) => sum + Number(item?.completed_items || 0), 0)
  return {
    loops,
    expandedLoops,
    totalItems,
    completedItems,
  }
})

const loopIndexOptions = computed<Array<{ value: string, label: string }>>(() => {
  const loopStats = status.value?.loop_stats || {}
  const selected = selectedStep.value

  if (selected && selected.startsWith('loop-group:')) {
    const memberNodeIds = loopGroupNodeIdsByKey.value[selected] || []
    const values = memberNodeIds
      .map(nodeId => loopStats[nodeId])
      .filter(Boolean)

    const maxTotal = values.reduce((max, entry) => Math.max(max, Number(entry?.total_items || 0)), 0)
    if (maxTotal <= 0) return []

    const options: Array<{ value: string, label: string }> = [{ value: '', label: 'All loop items' }]
    for (let i = 0; i < maxTotal; i++) {
      options.push({ value: String(i), label: `Index #${i}` })
    }
    return options
  }

  if (selected && !loopStats[selected]) {
    return []
  }

  const values = selected ? [loopStats[selected]].filter(Boolean) : Object.values(loopStats)
  const maxTotal = values.reduce((max, entry) => Math.max(max, Number(entry?.total_items || 0)), 0)
  if (maxTotal <= 0) return []

  const options: Array<{ value: string, label: string }> = [{ value: '', label: 'All loop items' }]
  for (let i = 0; i < maxTotal; i++) {
    options.push({ value: String(i), label: `Index #${i}` })
  }
  return options
})

const topologyStats = computed(() => {
  const levelArrays = Array.isArray(flowMeta.value?.analyzed?.levels)
    ? flowMeta.value?.analyzed?.levels as string[][]
    : []
  const levelCount = levelArrays.length
  const maxParallelWidth = levelArrays.reduce((max, level) => Math.max(max, level.length), 0)
  const activeParallelLevels = levelArrays.filter(level => level.length > 1).length

  const nodeDefs = definition.value?.nodes || {}
  const nodeEntries = Object.entries(nodeDefs) as Array<[string, any]>
  const fanoutNodes = nodeEntries.filter(([, node]) => Boolean(node?.fanout)).length
  const joinNodes = nodeEntries.filter(([, node]) => Array.isArray(node?.depends_on) && node.depends_on.length > 1).length
  const terminalCandidates = nodeEntries.filter(([, node]) => {
    const emits = Array.isArray((node as any)?.emits) ? (node as any).emits.length : 0
    return emits > 0
  }).length

  return {
    levelCount,
    maxParallelWidth,
    activeParallelLevels,
    fanoutNodes,
    joinNodes,
    terminalCandidates,
  }
})

const formattedNodeResult = computed(() => {
  if (selectedNodeResult.value === null || selectedNodeResult.value === undefined) {
    return 'null'
  }
  try {
    return JSON.stringify(selectedNodeResult.value, null, 2)
  }
  catch {
    return String(selectedNodeResult.value)
  }
})

</script>

<template>
  <div class="h-full flex flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-950">
    <UModal v-model:open="isDeleteModalOpen" title="Delete Run">
      <template #body>
        <div class="space-y-2">
          <p class="text-sm text-zinc-700 dark:text-zinc-200">
            Diesen terminalen Run inklusive zugehoeriger Artefakte loeschen?
          </p>
          <p class="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
            {{ runId }}
          </p>
          <p v-if="deleteError" class="text-xs text-red-600 dark:text-red-400">
            {{ deleteError }}
          </p>
        </div>
      </template>
      <template #footer>
        <div class="w-full flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            label="Abbrechen"
            :disabled="deletePending"
            @click="isDeleteModalOpen = false"
          />
          <UButton
            color="error"
            variant="solid"
            label="Loeschen"
            :loading="deletePending"
            @click="confirmDeleteRun"
          />
        </div>
      </template>
    </UModal>

    <USlideover v-model:open="isResultSlideoverOpen" title="Node Result">
      <template #content>
        <div class="h-full flex flex-col bg-white dark:bg-zinc-950">
          <div class="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 space-y-2">
            <div class="text-xs text-zinc-500 dark:text-zinc-400">Step</div>
            <div class="text-sm font-medium text-zinc-900 dark:text-zinc-100 break-all">{{ selectedResultStepKey || 'n/a' }}</div>
            <div v-if="resultNodeUidOptions.length > 1" class="space-y-1">
              <div class="text-xs text-zinc-500 dark:text-zinc-400">Loop item</div>
              <select
                v-model="selectedResultNodeUid"
                class="w-full text-xs rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1"
              >
                <option v-for="uid in resultNodeUidOptions" :key="uid" :value="uid">{{ uid }}</option>
              </select>
            </div>
          </div>

          <div class="flex-1 overflow-auto p-4">
            <div v-if="resultPending" class="text-sm text-zinc-500 dark:text-zinc-400">Loading result...</div>
            <div v-else-if="resultError" class="text-sm text-red-600 dark:text-red-400">{{ resultError }}</div>
            <div v-else-if="!selectedResultNodeUid" class="text-sm text-zinc-500 dark:text-zinc-400">No result available for this step yet.</div>
            <pre v-else class="text-xs leading-5 whitespace-pre-wrap break-words rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-3">{{ formattedNodeResult }}</pre>
          </div>
        </div>
      </template>
    </USlideover>

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
                :run-id="runId"
                :is-live="normalizedStatus === 'running' || normalizedStatus === 'awaiting' || normalizedStatus === 'awaiting_nodes'"
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
                :run-id="runId"
                :is-live="normalizedStatus === 'running' || normalizedStatus === 'awaiting' || normalizedStatus === 'awaiting_nodes'"
              />
            </template>
          </USlideover>

          <USlideover
            v-model="isCancelSlideoverOpen"
            title="Run Controls"
          >
            <UButton
              icon="i-lucide-shield-alert"
              color="neutral"
              variant="outline"
              :label="normalizedStatus ? `Controls: ${String(normalizedStatus).toUpperCase()}` : 'Controls'"
              @click="openCancelSlideover"
            />
            <template #content>
              <div class="h-full flex flex-col p-4 gap-4 bg-white dark:bg-zinc-950 overflow-y-auto">
                <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/40 p-3">
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <div class="text-xs font-semibold text-zinc-900 dark:text-zinc-100">Workflow Cancel</div>
                      <div class="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1">Run controls and queue cleanup diagnostics.</div>
                    </div>
                    <UBadge
                      v-if="normalizedStatus"
                      :label="String(normalizedStatus).toUpperCase()"
                      size="xs"
                      :color="normalizedStatus === 'completed' ? 'success' : normalizedStatus === 'failed' ? 'error' : 'neutral'"
                      variant="soft"
                    />
                  </div>

                  <div v-if="showCancelAction" class="mt-3">
                    <UButton
                      icon="i-lucide-x-circle"
                      color="error"
                      variant="solid"
                      :loading="cancelPending"
                      label="Cancel Run Now"
                      @click="cancelRun"
                    />
                  </div>
                  <div v-else class="mt-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-2 text-[11px] text-zinc-600 dark:text-zinc-300">
                    This run is terminal ({{ String(normalizedStatus || '').toUpperCase() }}). Cancel action is no longer available.
                  </div>
                </div>

                <div v-if="cancelError" class="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 text-xs text-red-700 dark:text-red-300">
                  {{ cancelError }}
                </div>

                <div
                  v-else-if="cancelResult || isRunCancelled"
                  class="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/50 p-3"
                >
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                      Cancel Execution Summary
                    </div>
                    <UBadge
                      :label="cancelResult ? (cancelCleanupHasErrors ? 'Partial Cleanup' : 'Cleanup OK') : 'Already Cancelled'"
                      :color="cancelResult ? (cancelCleanupHasErrors ? 'warning' : 'success') : 'neutral'"
                      size="xs"
                      variant="soft"
                    />
                  </div>

                  <div class="mt-3 grid grid-cols-2 gap-2">
                    <div class="rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-2 py-2">
                      <div class="text-[10px] uppercase tracking-wide text-zinc-500">Sessions Stopped</div>
                      <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ cancelDisplay.stopped_sessions }}</div>
                    </div>
                    <div class="rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-2 py-2">
                      <div class="text-[10px] uppercase tracking-wide text-zinc-500">Queue Fragments</div>
                      <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ cancelDisplay.queue_fragments_detected }}</div>
                    </div>
                    <div class="rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-2 py-2">
                      <div class="text-[10px] uppercase tracking-wide text-zinc-500">Receipts Tracked</div>
                      <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ cancelDisplay.tracked_receipt_count }}</div>
                    </div>
                    <div class="rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-2 py-2">
                      <div class="text-[10px] uppercase tracking-wide text-zinc-500">Cleanup Success</div>
                      <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ cancelCleanupRate }}%</div>
                    </div>
                  </div>

                  <div class="mt-3 text-[11px] text-zinc-600 dark:text-zinc-300">
                    <template v-if="cancelResult">
                      Attempted {{ cancelCleanupAttempted }}, succeeded {{ cancelCleanupSucceeded }}, failed {{ cancelCleanupErrorEntries.length }}.
                    </template>
                    <template v-else>
                      No cleanup diagnostics available from this session.
                    </template>
                  </div>

                  <details v-if="cancelCheckedQueues.length > 0 || cancelTrackedReceiptIds.length > 0 || cancelCleanupHasErrors" class="mt-3 group">
                    <summary class="cursor-pointer text-xs font-medium text-zinc-700 dark:text-zinc-200 list-none flex items-center gap-2">
                      <span class="inline-block transition-transform group-open:rotate-90">▶</span>
                      Show Cleanup Details
                    </summary>
                    <div class="mt-2 space-y-2">
                      <div v-if="cancelCheckedQueues.length > 0" class="text-[11px] text-zinc-600 dark:text-zinc-300">
                        <span class="font-medium">Queues:</span>
                        {{ cancelCheckedQueues.join(', ') }}
                      </div>
                      <div v-if="cancelTrackedReceiptIds.length > 0" class="text-[11px] text-zinc-600 dark:text-zinc-300">
                        <span class="font-medium">Receipt IDs:</span>
                        {{ cancelTrackedReceiptIds.join(', ') }}
                      </div>
                      <div v-if="cancelCleanupHasErrors" class="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-2">
                        <div class="text-[11px] font-semibold text-amber-800 dark:text-amber-300">Cleanup Errors</div>
                        <ul class="mt-1 space-y-1 text-[11px] text-amber-800/90 dark:text-amber-200/90 max-h-28 overflow-auto">
                          <li v-for="[receiptId, err] in cancelCleanupErrorEntries" :key="receiptId">
                            <span class="font-medium">{{ receiptId }}:</span> {{ err }}
                          </li>
                        </ul>
                      </div>
                    </div>
                  </details>
                </div>

                <div
                  v-if="isRunTerminal"
                  class="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/50 p-3"
                >
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                      Run Snapshot
                    </div>
                    <div class="flex items-center gap-2">
                      <UBadge
                        :label="String(normalizedStatus || 'terminal').toUpperCase()"
                        color="neutral"
                        size="xs"
                        variant="soft"
                      />
                      <UButton
                        icon="i-lucide-trash-2"
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        title="Delete run"
                        :loading="deletePending"
                        @click="openDeleteModal"
                      />
                    </div>
                  </div>

                  <div class="mt-3 grid grid-cols-2 gap-2">
                    <div class="rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-2 py-2">
                      <div class="text-[10px] uppercase tracking-wide text-zinc-500">Duration</div>
                      <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ runDurationLabel }}</div>
                    </div>
                    <div class="rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-2 py-2">
                      <div class="text-[10px] uppercase tracking-wide text-zinc-500">Nodes Total</div>
                      <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ nodeStats.total }}</div>
                    </div>
                    <div class="rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-2 py-2">
                      <div class="text-[10px] uppercase tracking-wide text-zinc-500">Nodes OK / Failed</div>
                      <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ nodeStats.completed }} / {{ nodeStats.failed }}</div>
                    </div>
                    <div class="rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-2 py-2">
                      <div class="text-[10px] uppercase tracking-wide text-zinc-500">Retries</div>
                      <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ nodeStats.retries }}</div>
                    </div>
                    <div class="rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-2 py-2">
                      <div class="text-[10px] uppercase tracking-wide text-zinc-500">Queue Receipts</div>
                      <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ statusQueueReceiptCount }}</div>
                    </div>
                  </div>

                  <div class="mt-3 text-[11px] text-zinc-600 dark:text-zinc-300">
                    Receipt queues {{ statusQueueReceiptQueueCount }}, receipt nodes {{ statusQueueReceiptNodeCount }}.
                  </div>
                </div>

                <div
                  class="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/50 p-3"
                >
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                      Execution Topology
                    </div>
                    <UBadge
                      :label="`${topologyStats.maxParallelWidth}x max parallel`"
                      color="info"
                      size="xs"
                      variant="soft"
                    />
                  </div>

                  <div class="mt-3 grid grid-cols-2 gap-2">
                    <div class="rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-2 py-2">
                      <div class="text-[10px] uppercase tracking-wide text-zinc-500">Depth (levels)</div>
                      <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ topologyStats.levelCount }}</div>
                    </div>
                    <div class="rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-2 py-2">
                      <div class="text-[10px] uppercase tracking-wide text-zinc-500">Parallel Levels</div>
                      <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ topologyStats.activeParallelLevels }}</div>
                    </div>
                    <div class="rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-2 py-2">
                      <div class="text-[10px] uppercase tracking-wide text-zinc-500">Join Nodes</div>
                      <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ topologyStats.joinNodes }}</div>
                    </div>
                    <div class="rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-2 py-2">
                      <div class="text-[10px] uppercase tracking-wide text-zinc-500">Fanout Nodes</div>
                      <div class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ topologyStats.fanoutNodes }}</div>
                    </div>
                  </div>

                  <div class="mt-3 text-[11px] text-zinc-600 dark:text-zinc-300">
                    Potential terminal emitters: {{ topologyStats.terminalCandidates }}.
                  </div>
                </div>
              </div>
            </template>
          </USlideover>

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
            :loop-overview="loopOverviewStats"
            :result="status.result"
            :flow-def="flowMeta"
            @select-step="selectedStep = $event"
            @cancel-flow="cancelRun"
            @restart-flow="() => {}"
            @inspect-step-result="openResultSlideover"
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
            :run-id="runId"
            :run-status="normalizedStatus || 'unknown'"
            :started-at="status?.created_at"
            :completed-at="status?.updated_at"
            :node-checkpoints="status?.nodes"
            :selected-step="selectedStep"
            :selected-step-node-ids="selectedStepNodeIds"
            :loop-index-options="loopIndexOptions"
          />
        </div>
      </div>
    </div>
  </div>
</template>
