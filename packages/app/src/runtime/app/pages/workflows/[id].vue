<script setup lang="ts">
import { useFetch, computed, useComponentRouter, onMounted, onUnmounted } from '#imports'
import { useWorkflowAnalysis } from '../../composables/useWorkflowAnalysis'

const { sortNodesByLevel, analyzeWorkflow } = useWorkflowAnalysis()
const { push, route } = useComponentRouter()
// In component router mode, params might be different, but let's assume we can get it from query or a passed prop
const props = defineProps<{
  runId?: string
}>()

const runId = computed(() => props.runId || (route.value.params.id as string))

const { data: status, pending, error, refresh } = useFetch('/api/_workflows/status', {
  params: { run_id: runId },
  watch: [runId]
})

const definition = computed(() => status.value?.definition)

// Auto-refresh while running
let refreshInterval: any = null
onMounted(() => {
  refreshInterval = setInterval(() => {
    const s = status.value?.status
    if (s === 'running' || s === 'awaiting_nodes' || s === 'awaiting') {
      refresh()
    }
  }, 3000)
})

onUnmounted(() => {
  if (refreshInterval) clearInterval(refreshInterval)
})


const normalizedStatus = computed(() => {
  const s = status.value?.status
  if (s === 'done') return 'completed'
  if (s === 'error') return 'failed'
  return s
})

// Convert WorkflowDef + StatusResponse to FlowMeta + stepStates
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
      // Standardize properties for Diagram component
      queue: (node as any).queue || 'default',
      runtype: (node as any).runtype || 'task',
      emits: (node as any).emits || []
    }
  })

  // Try to determine a single entry point for centered rendering in Diagram
  let entry = undefined
  if (analyzed.levels[0]?.length === 1) {
    const entryId = analyzed.levels[0][0]
    const node = definition.value.nodes[entryId]
    entry = {
      step: entryId,
      queue: (node as any).queue || 'default',
      workerId: node.function.id,
      runtime: node.function.runtime as 'nodejs' | 'python',
      runtype: (node as any).runtype || 'task',
      emits: (node as any).emits || []
    }
  }

  return {
    id: runId.value,
    entry,
    steps,
    analyzed
  }
})

const stepStates = computed(() => {
  if (!status.value?.nodes) return {}
  const out: Record<string, any> = {}
  Object.entries(status.value.nodes).forEach(([id, nodeStatus]: [string, any]) => {
    // NodeCheckpoint object from workflow_runs state
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
      retries: nodeStatus.retries
    }
  })
  return out
})

const stepList = computed(() => {
  if (!definition.value?.nodes) return []
  
  // Get sorted keys based on execution levels
  const sortedKeys = sortNodesByLevel(definition.value.nodes)
  
  // Create a list based on definition to show ALL steps in the sidebar
  return sortedKeys.map(id => {
    const state = stepStates.value[id]
    return {
      key: id,
      status: state?.status || 'idle',
      error: state?.error,
      result: state?.result,
      retries: state?.retries
    }
  })
})
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
           <UBadge
             v-if="normalizedStatus"
             :label="normalizedStatus.toUpperCase()"
             size="md"
             :color="normalizedStatus === 'completed' ? 'success' : normalizedStatus === 'failed' ? 'error' : 'neutral'"
             variant="outline"
           />
           <UButton
             icon="i-heroicons-arrow-path"
             color="neutral"
             variant="outline"
             :loading="pending"
             @click="refresh"
           />
        </div>
      </div>
    </div>

    <!-- Main Content: Split View -->
    <div class="flex-1 flex overflow-hidden">
      <!-- Left: Diagram -->
      <div class="flex-1 relative overflow-hidden border-r border-zinc-200 dark:border-zinc-800">
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
          <!-- We use the existing Diagram component -->
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

      <!-- Right: Details Sidebar -->
      <div class="w-96 shrink-0 bg-white dark:bg-zinc-950 flex flex-col overflow-hidden">
        <NventFlowRunOverview
          v-if="status"
          :run-status="normalizedStatus"
          :run-id="runId"
          :steps="stepList"
          :started-at="status.created_at"
          :completed-at="status.updated_at"
          :result="status.result"
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
    </div>
  </div>
</template>
