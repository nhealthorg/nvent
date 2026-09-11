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
          :min-zoom="0.05"
          :max-zoom="4"
          :default-viewport="{ zoom: 0.5 }"
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
              :position="Position.Left"
            />
            <Handle
              type="source"
              :position="Position.Right"
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
              :position="Position.Right"
            />
          </template>

          <template #node-flow-await="{ data }">
            <FlowAwaitNode
              :data="data"
            />
            <Handle
              type="target"
              :position="Position.Left"
            />
            <Handle
              type="source"
              :position="Position.Right"
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
import { Position, Handle } from '@vue-flow/core'
import FlowNodeCard from './NodeCard.vue'
import FlowAwaitNode from './AwaitNode.vue'
import { useFlowLayout } from '../../composables/useFlowLayout'

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

const { nodes, edges } = useFlowLayout(props)

// Internal state for interaction and persistence
const internalNodes = ref<VFNode[]>([])
const internalEdges = ref<VFEdge[]>([])

const topologySignature = computed(() => JSON.stringify({
  nodes: nodes.value.map(node => ({
    id: node.id,
    type: node.type,
    position: node.position,
    sourcePosition: node.sourcePosition,
    targetPosition: node.targetPosition,
  })),
  edges: edges.value.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
  })),
}))

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

// Rebuild only when node/edge topology changes. Polling replaces the flow
// object, but must not reset the user's viewport or node interaction state.
watch(topologySignature, () => {
  const f = props.flow
  if (!f) {
    internalNodes.value = []
    internalEdges.value = []
    return
  }
  const builtNodes: VFNode[] = nodes.value.map(n => ({ 
    id: n.id, 
    position: { ...n.position }, 
    data: { ...n.data }, 
    type: n.type, 
    style: n.style,
    sourcePosition: (n as any).sourcePosition,
    targetPosition: (n as any).targetPosition
  }))
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
}, { immediate: true })

// Update node data when stepStates change (for live status updates)
watch([() => props.stepStates, () => props.flowStatus], () => {
  if (!props.flow) return

  // Get latest computed nodes with updated status
  const latestNodes = nodes.value

  const latestById = new Map(latestNodes.map(node => [node.id, node]))
  for (const node of internalNodes.value) {
    const latest = latestById.get(node.id)
    if (!latest) continue
    Object.assign(node.data, latest.data)
    node.style = latest.style
  }

  const latestEdgesById = new Map(edges.value.map(edge => [edge.id, edge]))
  for (const edge of internalEdges.value) {
    const latest = latestEdgesById.get(edge.id)
    if (!latest) continue
    edge.animated = latest.animated
    edge.label = latest.label
  }
}, { deep: true })

// Persist only position changes, not every status/data update.
watch(
  () => internalNodes.value.map(node => [node.id, node.position.x, node.position.y]),
  () => savePositionsDebounced(props.flow?.id),
  { deep: true },
)

function onNodeClick(evt: any) {
  const id = evt?.node?.id || evt?.id
  if (id) emit('nodeSelected', { id })
}

function onAction(payload: { id: string, action: 'run' | 'logs' | 'details' }) {
  emit('nodeAction', payload)
}

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
    sourcePosition: (n as any).sourcePosition,
    targetPosition: (n as any).targetPosition
  }))
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

/* Handle Styling */
:deep(.vue-flow__handle) {
  width: 8px;
  height: 8px;
  background-color: #94a3b8; /* gray-400 */
  border: 2px solid white;
}

.dark :deep(.vue-flow__handle) {
  border-color: #1e293b; /* gray-800 */
}

:deep(.vue-flow__handle-left) {
  left: -4px;
}

:deep(.vue-flow__handle-right) {
  right: -4px;
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
