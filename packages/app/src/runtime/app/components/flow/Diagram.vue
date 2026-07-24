<template>
  <div
    :class="heightClass"
    class="w-full border rounded bg-white/5"
  >
    <ClientOnly>
      <div class="relative h-full">
        <button
          v-if="flowId"
          class="absolute z-10 top-2 right-2 bg-gray-700 hover:bg-gray-600 text-white text-xs px-2 py-1 rounded"
          type="button"
          title="Reset layout"
          @click="resetLayout()"
        >
          Reset
        </button>
        <VueFlow
          ref="vueFlowRef"
          v-model:nodes="internalNodes"
          v-model:edges="internalEdges"
          :fit-view-on-init="true"
          class="h-full w-full"
          @node-click="onNodeClick"
        >
          <template #node-flow-loop-group="{ data }">
            <div class="loop-group-node">
              <div class="loop-group-header">
                <UIcon
                  name="i-heroicons-arrow-path-rounded-square-20-solid"
                  class="size-3.5"
                />
                <span>{{ data?.title || 'For Loop' }}</span>
                <UBadge
                  size="xs"
                  color="info"
                  variant="soft"
                  :label="data?.mode || 'parallel'"
                />
              </div>
              <div
                v-if="data?.over"
                class="loop-group-line"
                :title="String(data.over)"
              >
                over {{ data.over }}
              </div>
              <div
                v-if="data?.pipeline"
                class="loop-group-line"
                :title="String(data.pipeline)"
              >
                {{ data.pipeline }}
              </div>
            </div>
          </template>

          <template #node-flow-step="{ id, data }">
            <FlowNodeCard
              :id="id"
              :data="data"
              kind="step"
              @action="onAction"
            />
            <Handle
              type="target"
              :position="Position.Top"
            />
            <Handle
              type="source"
              :position="Position.Bottom"
            />
          </template>

          <template #node-flow-entry="{ id, data }">
            <FlowNodeCard
              :id="id"
              :data="data"
              kind="entry"
              @action="onAction"
            />
            <Handle
              type="source"
              :position="Position.Bottom"
            />
          </template>

          <template #node-flow-await="{ data }">
            <FlowAwaitNode
              :data="data"
            />
            <Handle
              type="target"
              :position="Position.Top"
            />
            <Handle
              type="source"
              :position="Position.Bottom"
            />
          </template>

          <Background
            v-if="showBackground"
            pattern-color="#888"
            :gap="12"
          />
          <Controls v-if="showControls" />
          <MiniMap v-if="showMiniMap" />
        </VueFlow>
      </div>
    </ClientOnly>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from '#imports'
import type { Node as VFNode, Edge as VFEdge } from '@vue-flow/core'
import { Handle, Position } from '@vue-flow/core'
import FlowNodeCard from './NodeCard.vue'
import FlowAwaitNode from './AwaitNode.vue'

interface AwaitConfig {
  type: 'time' | 'event' | 'webhook'
  delay?: number
  event?: string
  method?: string
  timeout?: number
  timeoutAction?: 'fail' | 'continue'
}

interface FlowEntry {
  step: string
  queue: string
  engineRetryMax?: number
  workerId: string
  runtime?: 'nodejs' | 'python'
  runtype?: 'inprocess' | 'task'
  emits?: string[]
  awaitBefore?: AwaitConfig
  awaitAfter?: AwaitConfig
  [key: string]: any
}
interface FlowStep {
  queue: string
  engineRetryMax?: number
  workerId: string
  subscribes?: string[]
  runtime?: 'nodejs' | 'python'
  runtype?: 'inprocess' | 'task'
  emits?: string[]
  awaitBefore?: AwaitConfig
  awaitAfter?: AwaitConfig
  [key: string]: any
}

interface AnalyzedStep extends FlowStep {
  name: string
  dependsOn: string[]
  triggers: string[]
  level: number
  stepTimeout?: number
}

interface FlowMeta {
  id: string
  entry?: FlowEntry
  steps?: Record<string, FlowStep>
  loopGroups?: Array<{
    id: string
    mode: 'parallel' | 'sequential'
    over: string
    nodeIds: string[]
    label: string
  }>
  analyzed?: {
    levels: string[][]
    maxLevel: number
    steps: Record<string, AnalyzedStep>
  }
}

interface StepStatus {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'retrying' | 'waiting' | 'resolved' | 'timeout' | 'canceled' | 'stalled'
  attempt?: number
  error?: string
  scheduledTriggerAt?: string
  retries?: number
  worker_name?: string
  pending_at?: number
  completed_at?: number
  awaitData?: any
}

const props = defineProps<{
  flow?: any
  heightClass?: string
  showControls?: boolean
  showMiniMap?: boolean
  showBackground?: boolean
  stepStates?: Record<string, any> // Current execution state
  flowStatus?: 'running' | 'completed' | 'failed' | 'canceled' | 'stalled' | 'awaiting' // Overall flow status
}>()

const heightClass = computed(() => props.heightClass || 'h-80')
const emit = defineEmits<{
  (e: 'nodeSelected', payload: { id: string }): void
  (e: 'nodeAction', payload: { id: string, action: 'run' | 'logs' | 'details' }): void
}>()
const flowId = computed(() => props.flow?.id)
const vueFlowRef = ref<any>(null)

type StepNodeData = {
  label: string
  queue?: string
  engineRetryMax?: number
  workerId?: string
  status?: 'idle' | 'running' | 'error' | 'done' | 'canceled'
  attempt?: number
  retries?: number
  error?: string
  runtime?: 'nodejs' | 'python'
  runtype?: 'inprocess' | 'task'
  subscribes?: string[]
  emits?: string[]
  stepTimeout?: number
  worker_name?: string
  pending_at?: number
  completed_at?: number
  [key: string]: any
}

type AwaitNodeData = {
  label: string
  awaitType?: 'time' | 'event' | 'webhook'
  awaitConfig?: AwaitConfig
  status?: 'idle' | 'waiting' | 'resolved' | 'timeout'
  scheduledTriggerAt?: string
  awaitData?: any
  [key: string]: any
}

type FlowNode = {
  id: string
  position: { x: number, y: number }
  data: StepNodeData | AwaitNodeData
  type?: string
  style?: Record<string, any>
}
type FlowEdge = { id: string, source: string, target: string, label?: string, animated?: boolean }

const nodes = computed<FlowNode[]>(() => {
  const out: FlowNode[] = []
  const f = props.flow
  if (!f) return out

  const states = props.stepStates || {}
  const colWidth = 360
  const rowHeight = 220
  const horizontalGap = 100
  const verticalGap = 130
  const awaitRowHeight = 140 // Height for await node rows (matches step row height)
  const nodeWidth = 320

  let y = 0

  function estimateStepHeight(stepLike: any): number {
    if (stepLike?.loopGroupId) return 250
    return 210
  }

  // Entry node (centered) - offset by half width to center properly
  if (f.entry) {
    const entryState = states[f.entry.step]
    const status = mapStatusToNodeStatus(entryState?.status)
    const entryHeight = estimateStepHeight(f.entry)

    // Get stepTimeout from analyzed flow metadata (includes config priority)
    const entryStepTimeout = f.analyzed?.steps?.[f.entry.step]?.stepTimeout

    out.push({
      id: `entry:${f.entry.step}`,
      position: { x: -nodeWidth / 2, y: y },
      data: {
        label: f.entry.step,
        queue: f.entry.queue,
        engineRetryMax: f.entry.engineRetryMax,
        workerId: f.entry.workerId,
        status,
        attempt: entryState?.attempt,
        retries: entryState?.retries,
        error: entryState?.error,
        runtime: f.entry.runtime,
        runtype: f.entry.runtype,
        emits: f.entry.emits,
        awaitBefore: f.entry.awaitBefore,
        awaitAfter: f.entry.awaitAfter,
        stepTimeout: entryStepTimeout,
        worker_name: entryState?.worker_name,
        pending_at: entryState?.pending_at,
        completed_at: entryState?.completed_at,
        isLoop: f.entry.isLoop,
        loopOver: f.entry.loopOver,
        loopMode: f.entry.loopMode,
        __nodeHeight: entryHeight,
      },
      type: 'flow-entry',
      style: { minWidth: `${nodeWidth}px`, zIndex: 20 },
    })
    y += entryHeight + verticalGap

    // Add await row after entry if needed
    if (f.entry.awaitAfter) {
      const awaitKey = `${f.entry.step}:await-after`
      const awaitState = states[awaitKey]
      const awaitStatus = awaitState?.status === 'waiting' ? 'waiting' : awaitState?.status === 'completed' ? 'resolved' : awaitState?.status === 'timeout' ? 'timeout' : 'idle'

      out.push({
        id: `await:entry-after:${f.entry.step}`,
        position: { x: -120, y: y },
        data: {
          label: `Await (${f.entry.awaitAfter.type})`,
          awaitType: f.entry.awaitAfter.type,
          awaitConfig: f.entry.awaitAfter,
          awaitData: awaitState?.awaitData,
          status: awaitStatus,
          scheduledTriggerAt: awaitState?.scheduledTriggerAt,
        },
        type: 'flow-await',
        style: { minWidth: '180px' },
      })
      y += awaitRowHeight + verticalGap
    }
  }

  // Use analyzed levels if available, otherwise fall back to simple grid
  const steps = f.steps || {}

  if (f.analyzed?.levels && f.analyzed.levels.length > 0) {
    // Use analyzed levels for better layout
    // Skip level 0 only if entry step is already rendered above
    const startLevel = f.entry ? 1 : 0
    const levels = f.analyzed.levels.slice(startLevel).filter(level => level.length > 0) // Skip empty levels

    levels.forEach((levelSteps) => {
      if (levelSteps.length === 0) return

      // Create await nodes for steps with awaitBefore (but don't add space yet)
      const awaitNodesCreated: string[] = []
      levelSteps.forEach((stepName) => {
        const step = steps[stepName]
        if (!step?.awaitBefore) return

        const awaitState = states[`${stepName}:await-before`]
        const awaitStatus = awaitState?.status === 'waiting' ? 'waiting' : awaitState?.status === 'completed' ? 'resolved' : awaitState?.status === 'timeout' ? 'timeout' : 'idle'

        out.push({
          id: `await:step-before:${stepName}`,
          position: { x: 0, y: y }, // Temporary position
          data: {
            label: `Await (${step.awaitBefore.type})`,
            awaitType: step.awaitBefore.type,
            awaitConfig: step.awaitBefore,
            awaitData: awaitState?.awaitData,
            status: awaitStatus,
            scheduledTriggerAt: awaitState?.scheduledTriggerAt,
          },
          type: 'flow-await',
          style: { minWidth: '180px' },
        })
        awaitNodesCreated.push(stepName)
      })

      // Only add space if we actually created await nodes
      if (awaitNodesCreated.length > 0) {
        y += awaitRowHeight + verticalGap
      }

      const cols = Math.min(4, levelSteps.length) // Max 4 columns per level
      const rows = Math.ceil(levelSteps.length / cols)

      levelSteps.forEach((stepName, idx) => {
        const step = steps[stepName]
        if (!step) return

        const stepState = states[stepName]
        const status = mapStatusToNodeStatus(stepState?.status)

        const col = idx % cols
        const row = Math.floor(idx / cols)

        // Calculate how many nodes are in this specific row within this level
        const remainingInLevel = levelSteps.length - (row * cols)
        const nodesInThisRow = Math.min(cols, remainingInLevel)

        // Center this row based on its actual node count
        const rowWidth = nodesInThisRow * colWidth + (nodesInThisRow - 1) * horizontalGap
        const rowStartX = -rowWidth / 2

        const x = rowStartX + col * (colWidth + horizontalGap)
        const yPos = y + row * (rowHeight + verticalGap)
        const stepHeight = estimateStepHeight(step)

        // Get stepTimeout from analyzed flow metadata (static data)
        const analyzedStep = f.analyzed?.steps?.[stepName]
        const stepStepTimeout = (analyzedStep as any)?.stepTimeout

        out.push({
          id: `step:${stepName}`,
          position: { x, y: yPos },
          data: {
            label: stepName,
            queue: step?.queue,
            engineRetryMax: step?.engineRetryMax,
            workerId: step?.workerId,
            status,
            attempt: stepState?.attempt,
            retries: stepState?.retries,
            error: stepState?.error,
            runtime: step?.runtime,
            runtype: step?.runtype,
            subscribes: step?.subscribes,
            emits: step?.emits,
            awaitBefore: step?.awaitBefore,
            awaitAfter: step?.awaitAfter,
            stepTimeout: stepStepTimeout,
            worker_name: stepState?.worker_name,
            pending_at: stepState?.pending_at,
            completed_at: stepState?.completed_at,
            isLoop: step?.isLoop,
            loopOver: step?.loopOver,
            loopMode: step?.loopMode,
            loopGroupId: (step as any)?.loopGroupId,
            loopPipeline: (step as any)?.loopPipeline,
            loopGroupSize: (step as any)?.loopGroupSize,
            __nodeHeight: stepHeight,
          },
          type: 'flow-step',
          style: { minWidth: `${nodeWidth}px`, zIndex: 20 },
        })

        // Update await node position to align with step x position
        if (step.awaitBefore) {
          const awaitNode = out.find(n => n.id === `await:step-before:${stepName}`)
          if (awaitNode) {
            awaitNode.position.x = x - 20 // Center align with step
          }
        }

        // Add await row after step if it has awaitAfter
        if (step.awaitAfter && row === rows - 1 && idx === levelSteps.length - 1) {
          // This is the last step in the level, add await row after
          const awaitKey = `${stepName}:await-after`
          const awaitState = states[awaitKey]
          const awaitStatus = awaitState?.status === 'waiting' ? 'waiting' : awaitState?.status === 'completed' ? 'resolved' : awaitState?.status === 'timeout' ? 'timeout' : 'idle'

          out.push({
            id: `await:step-after:${stepName}`,
            position: { x: x - 20, y: yPos + stepHeight + verticalGap },
            data: {
              label: `Await (${step.awaitAfter.type})`,
              awaitType: step.awaitAfter.type,
              awaitConfig: step.awaitAfter,
              awaitData: awaitState?.awaitData,
              status: awaitStatus,
              scheduledTriggerAt: awaitState?.scheduledTriggerAt,
            },
            type: 'flow-await',
            style: { minWidth: '180px' },
          })
        }
      })

      // Move Y down for next level (account for all rows in this level)
      y += rows * (rowHeight + verticalGap)

      // Add extra space if last step in level has awaitAfter
      const lastStepName = levelSteps[levelSteps.length - 1]
      if (lastStepName && steps[lastStepName]?.awaitAfter) {
        y += awaitRowHeight + verticalGap
      }
    })
  }
  else {
    // Fallback: simple grid layout
    const names = Object.keys(steps)
    const cols = 3

    names.forEach((name, idx) => {
      const step = steps[name]
      const stepState = states[name]
      const status = mapStatusToNodeStatus(stepState?.status)

      const col = idx % cols
      const row = Math.floor(idx / cols)

      // Calculate how many nodes are in this specific row
      const totalRows = Math.ceil(names.length / cols)
      const isLastRow = row === totalRows - 1
      const nodesInThisRow = isLastRow ? (names.length % cols || cols) : cols

      // Center this row based on its actual node count
      const rowWidth = nodesInThisRow * colWidth + (nodesInThisRow - 1) * horizontalGap
      const rowStartX = -rowWidth / 2

      const x = rowStartX + col * (colWidth + horizontalGap)
      const yPos = y + row * (rowHeight + verticalGap)
      const stepHeight = estimateStepHeight(step)

      // Get stepTimeout from analyzed flow metadata (static data)
      const analyzedStep = f.analyzed?.steps?.[name]
      const stepStepTimeout = (analyzedStep as any)?.stepTimeout

      out.push({
        id: `step:${name}`,
        position: { x, y: yPos },
        data: {
          label: name,
          queue: step?.queue,
          workerId: step?.workerId,
          status,
          attempt: stepState?.attempt,
          retries: stepState?.retries,
          error: stepState?.error,
          runtime: step?.runtime,
          runtype: step?.runtype,
          emits: step?.emits,
          stepTimeout: stepStepTimeout,
          worker_name: stepState?.worker_name,
          pending_at: stepState?.pending_at,
          completed_at: stepState?.completed_at,
          loopGroupId: (step as any)?.loopGroupId,
          loopPipeline: (step as any)?.loopPipeline,
          loopGroupSize: (step as any)?.loopGroupSize,
          __nodeHeight: stepHeight,
        },
        type: 'flow-step',
        style: { minWidth: `${nodeWidth}px`, zIndex: 20 },
      })
    })
  }

  const loopGroups = Array.isArray(f.loopGroups) ? f.loopGroups : []
  for (const loopGroup of loopGroups) {
    const memberNodes = out.filter(node =>
      node.id.startsWith('step:')
      && loopGroup.nodeIds.includes(node.id.replace('step:', '')),
    )
    if (memberNodes.length === 0) continue

    const minX = Math.min(...memberNodes.map(node => node.position.x))
    const minY = Math.min(...memberNodes.map(node => node.position.y))
    const maxX = Math.max(...memberNodes.map(node => node.position.x + nodeWidth))
    const maxY = Math.max(...memberNodes.map(node => {
      const nodeHeight = Number((node.data as any)?.__nodeHeight || rowHeight)
      return node.position.y + nodeHeight
    }))
    const paddingX = 40
    const paddingTop = 54
    const paddingBottom = 44

    out.unshift({
      id: `loop-group:${loopGroup.id}`,
      position: { x: minX - paddingX, y: minY - paddingTop },
      data: {
        title: `For Loop ${loopGroup.id.toUpperCase()}`,
        over: loopGroup.over,
        mode: loopGroup.mode,
        pipeline: loopGroup.label,
      } as any,
      type: 'flow-loop-group',
      style: {
        width: `${Math.max(320, maxX - minX + paddingX * 2)}px`,
        height: `${Math.max(220, maxY - minY + paddingTop + paddingBottom)}px`,
        zIndex: 1,
        pointerEvents: 'none',
      },
    })
  }

  return out
})

// Map step status to node visual status
function mapStatusToNodeStatus(status?: string): 'idle' | 'running' | 'error' | 'done' | 'canceled' {
  switch (status) {
    case 'running':
    case 'retrying':
    case 'waiting':
      return 'running'
    case 'completed':
      return 'done'
    case 'failed':
    case 'timeout':
    case 'stalled':
      return 'error'
    case 'canceled':
      return 'canceled'
    default:
      return 'idle'
  }
}

const edges = computed<FlowEdge[]>(() => {
  const f = props.flow
  if (!f) return []
  const states = props.stepStates || {}
  const steps = f.steps || {}

  const added = new Set<string>()
  const out: FlowEdge[] = []

  function addEdge(source: string, target: string, label?: string) {
    const id = `${source}->${target}${label ? `:${label}` : ''}`
    if (added.has(id)) return

    // Determine if edge should be animated
    // Extract the actual step/node name from the ID
    const getNodeState = (nodeId: string) => {
      // Handle different node types:
      // - 'entry:step-name' -> states['step-name']
      // - 'step:step-name' -> states['step-name']
      // - 'await:entry-after:step-name' -> states['step-name:await-after']
      // - 'await:step-before:step-name' -> states['step-name:await-before']
      // - 'await:step-after:step-name' -> states['step-name:await-after']

      if (nodeId.startsWith('await:entry-after:')) {
        const stepName = nodeId.replace('await:entry-after:', '')
        return states[`${stepName}:await-after`]
      }
      if (nodeId.startsWith('await:step-before:')) {
        const stepName = nodeId.replace('await:step-before:', '')
        return states[`${stepName}:await-before`]
      }
      if (nodeId.startsWith('await:step-after:')) {
        const stepName = nodeId.replace('await:step-after:', '')
        return states[`${stepName}:await-after`]
      }
      // For entry: and step: nodes, extract the step name
      const parts = nodeId.split(':')
      return parts[1] ? states[parts[1]] : undefined
    }

    const sourceState = getNodeState(source)
    const targetState = getNodeState(target)

    // Animate if source is completed/resolved and target is running/pending/waiting
    // Don't animate if flow is canceled or completed/failed
    const shouldAnimate = (props.flowStatus === 'running' || props.flowStatus === 'awaiting')
      && (sourceState?.status === 'completed' || sourceState?.status === 'resolved')
      && (targetState?.status === 'running' || targetState?.status === 'pending' || targetState?.status === 'waiting' || !targetState)

    added.add(id)
    out.push({ id, source, target, label, animated: shouldAnimate })
  }

  // Always use analyzed dependencies
  if (f.analyzed?.steps) {
    const analyzedSteps = f.analyzed.steps

    // Add edge from entry to its awaitAfter node if it exists
    if (f.entry?.awaitAfter) {
      const entryId = `entry:${f.entry.step}`
      const entryAwaitId = `await:entry-after:${f.entry.step}`
      addEdge(entryId, entryAwaitId)
    }

    // Add edges based on analyzed dependencies
    for (const [stepName, stepInfo] of Object.entries(analyzedSteps)) {
      // Skip entry step - we handled it above
      if (stepName === f.entry?.step) continue

      const targetStep = steps[stepName]
      const target = `step:${stepName}`

      // Add edge from step to its awaitAfter node if it exists
      if (targetStep?.awaitAfter) {
        const stepId = `step:${stepName}`
        const awaitAfterId = `await:step-after:${stepName}`
        addEdge(stepId, awaitAfterId)
      }

      if (stepInfo.dependsOn.length > 0) {
        // Add edges from dependencies
        for (const depName of stepInfo.dependsOn) {
          let source: string

          // If dependency is the entry step and entry has awaitAfter,
          // connect from the entry's await node instead
          if (depName === f.entry?.step) {
            source = f.entry.awaitAfter
              ? `await:entry-after:${depName}`
              : `entry:${depName}`
          }
          else {
            // Check if dependency step has awaitAfter - connect from its await node
            const depStep = steps[depName]
            source = depStep?.awaitAfter
              ? `await:step-after:${depName}`
              : `step:${depName}`
          }

          // Check if target step has awaitBefore - insert await node
          if (targetStep?.awaitBefore) {
            const awaitNodeId = `await:step-before:${stepName}`
            addEdge(source, awaitNodeId)
            addEdge(awaitNodeId, target)
          }
          else {
            addEdge(source, target)
          }
        }
      }
    }
  }
  else {
    console.warn('[FlowDiagram] No analyzed data available for edges')
  }

  return out
})

// Internal state for interaction and persistence
const internalNodes = ref<VFNode[]>([])
const internalEdges = ref<VFEdge[]>([])

function storageKey(flowId?: string) {
  return flowId ? `flow-layout:${flowId}` : 'flow-layout:unknown'
}

function applySavedPositions(nodesIn: VFNode[], flowId?: string) {
  if (!flowId) return nodesIn
  try {
    const raw = localStorage.getItem(storageKey(flowId))
    if (!raw) return nodesIn
    const saved: Array<{ id: string, x: number, y: number }> = JSON.parse(raw)
    const byId = new Map(saved.map(s => [s.id, s]))
    nodesIn.forEach((n) => {
      const s = byId.get(n.id)
      if (s) n.position = { x: s.x, y: s.y }
    })
  }
  catch {
    // ignore
  }
  return nodesIn
}

function savePositionsDebounced(flowId?: string) {
  if (!flowId) return
  const payload = (internalNodes.value as Array<{ id: string, position: { x: number, y: number } }>).map(
    n => ({ id: n.id, x: n.position.x, y: n.position.y }),
  )
  try {
    localStorage.setItem(storageKey(flowId), JSON.stringify(payload))
  }
  catch {
    // ignore quota errors
  }
}

// Rebuild internal state when flow changes
watch(() => props.flow, (f) => {
  if (!f) {
    internalNodes.value = []
    internalEdges.value = []
    return
  }
  const builtNodes: VFNode[] = nodes.value.map(n => ({ id: n.id, position: { ...n.position }, data: { ...n.data }, type: n.type, style: n.style }))
  const builtEdges: VFEdge[] = edges.value.map(e => ({ id: e.id, source: e.source, target: e.target, label: e.label, animated: e.animated }))
  applySavedPositions(builtNodes, f.id)
  internalNodes.value = builtNodes
  internalEdges.value = builtEdges

  // Trigger fit view after nodes are rendered
  setTimeout(() => {
    if (vueFlowRef.value) {
      vueFlowRef.value.fitView({ padding: 0.2, duration: 200 })
    }
  }, 100)
}, { immediate: true, deep: false })

// Update node data when stepStates change (for live status updates)
watch([() => props.stepStates, () => props.flowStatus], () => {
  if (!props.flow) return

  // Get latest computed nodes with updated status
  const latestNodes = nodes.value

  // Preserve positions from current internal nodes
  const positionMap = new Map(internalNodes.value.map(n => [n.id, n.position]))

  // Build completely new nodes array with updated data and preserved positions
  const updatedNodes: VFNode[] = latestNodes.map(n => ({
    id: n.id,
    position: positionMap.get(n.id) || { ...n.position },
    data: { ...n.data }, // Create new data object reference
    type: n.type,
    style: n.style,
  }))

  // Replace entire array to trigger Vue Flow reactivity
  internalNodes.value = updatedNodes

  // Update edges for animation
  const builtEdges: VFEdge[] = edges.value.map(e => ({ id: e.id, source: e.source, target: e.target, label: e.label, animated: e.animated }))
  internalEdges.value = builtEdges
}, { deep: true })

// Persist on any node movement
watch(internalNodes, () => savePositionsDebounced(props.flow?.id), { deep: true })

function onNodeClick(evt: any) {
  const id = evt?.node?.id || evt?.id
  if (id) emit('nodeSelected', { id })
}

function onAction(payload: { id: string, action: 'run' | 'logs' | 'details' }) {
  emit('nodeAction', payload)
}

// no-op placeholder removed (status styling handled inside FlowNodeCard)

function resetLayout() {
  const id = flowId.value
  if (!id) return

  try {
    localStorage.removeItem(storageKey(id))
  }
  catch {
    // ignore
  }

  // Get fresh positions from computed nodes (without saved positions)
  const freshNodes: VFNode[] = nodes.value.map(n => ({
    id: n.id,
    position: { x: n.position.x, y: n.position.y },
    data: { ...n.data },
    type: n.type,
    style: n.style,
  }))

  // Update internal nodes with fresh positions
  internalNodes.value = freshNodes

  // Use Vue Flow's fitView to center and zoom the diagram
  nextTick(() => {
    if (vueFlowRef.value) {
      vueFlowRef.value.fitView({
        padding: 0.2,
        includeHiddenNodes: false,
        duration: 300,
      })
    }
  })
}
</script>

<style scoped>
:deep(.vue-flow__node) {
  padding: 0;
  background: transparent;
  border: none;
  box-shadow: none;
  overflow: visible;
  display: inline-block;
}

/* Remove the blue frame from the special "input" node type */
:deep(.vue-flow__node-input) {
  border: none;
}

/* Remove selection/focus blue glow on nodes */
:deep(.vue-flow__node.selected),
:deep(.vue-flow__node:focus) {
  box-shadow: none;
  outline: none;
  border: none;
}

.loop-group-node {
  width: 100%;
  height: 100%;
  border: 1px dashed rgba(14, 116, 144, 0.45);
  border-radius: 12px;
  background: rgba(236, 254, 255, 0.55);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dark .loop-group-node {
  border-color: rgba(34, 211, 238, 0.4);
  background: rgba(8, 47, 73, 0.35);
}

.loop-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: rgb(14 116 144);
}

.dark .loop-group-header {
  color: rgb(103 232 249);
}

.loop-group-line {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace;
  font-size: 10px;
  color: rgb(8 47 73);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dark .loop-group-line {
  color: rgb(207 250 254);
}
</style>
