<script setup lang="ts">
import { useFetch, computed, useComponentRouter, onMounted, onUnmounted } from '#imports'


const { push, route } = useComponentRouter()
// In component router mode, params might be different, but let's assume we can get it from query or a passed prop
const props = defineProps<{
  runId?: string
}>()

const runId = computed(() => props.runId || (route.value.params.id as string))

const { data: status, pending: statusPending, error: statusError, refresh } = useFetch('/api/_workflows/status', {
  params: { run_id: runId },
  watch: [runId]
})

// Auto-refresh while running
let refreshInterval: any = null
onMounted(() => {
  refreshInterval = setInterval(() => {
    if (status.value?.status === 'running' || status.value?.status === 'awaiting') {
      refresh()
    }
  }, 3000)
})

onUnmounted(() => {
  if (refreshInterval) clearInterval(refreshInterval)
})

const { data: definition, pending: defPending } = useFetch('/api/_workflows/definition', {
  params: { run_id: runId },
  watch: [runId]
})

const pending = computed(() => statusPending.value || defPending.value)
const error = computed(() => statusError.value)

const normalizedStatus = computed(() => {
  const s = status.value?.status
  if (s === 'done') return 'completed'
  if (s === 'error') return 'failed'
  return s
})

// Convert WorkflowDef + StatusResponse to FlowMeta + stepStates
const flowMeta = computed(() => {
  if (!definition.value?.nodes) return null
  
  const steps: Record<string, any> = {}
  const nodes = definition.value.nodes
  
  Object.entries(nodes).forEach(([id, node]: [string, any]) => {
    steps[id] = {
      name: id,
      workerId: node.function?.id,
      dependsOn: node.depends_on || []
    }
  })

  // Simple leveling for layout
  const levels: string[][] = [[]] // Level 0 (unused)
  const placed = new Set<string>()
  const analyzedSteps: Record<string, any> = {}
  
  while (placed.size < Object.keys(steps).length) {
    const currentLevel = []
    for (const id in steps) {
      if (placed.has(id)) continue
      const deps = steps[id].dependsOn
      if (deps.length === 0 || deps.every((d: string) => placed.has(d))) {
        currentLevel.push(id)
      }
    }
    if (currentLevel.length === 0) break
    levels.push(currentLevel)
    currentLevel.forEach(id => {
      placed.add(id)
      analyzedSteps[id] = {
        name: id,
        dependsOn: steps[id].dependsOn,
        level: levels.length - 1
      }
    })
  }

  return {
    id: runId.value,
    steps,
    analyzed: {
      levels,
      steps: analyzedSteps
    }
  }
})

const stepStates = computed(() => {
  if (!status.value?.nodes) return {}
  const out: Record<string, any> = {}
  Object.entries(status.value.nodes).forEach(([id, nodeStatus]) => {
    // Map engine status to UI status
    let uiStatus = nodeStatus as string
    if (uiStatus === 'done') uiStatus = 'completed'
    else if (uiStatus === 'error') uiStatus = 'failed'
    else if (uiStatus === 'active' || uiStatus === 'queued') uiStatus = 'running'

    out[id] = {
      status: uiStatus,
      error: status.value.node_errors?.[id],
      result: status.value.node_results?.[id]
    }
  })
  return out
})

const stepList = computed(() => {
  if (!definition.value?.nodes) return []
  
  // Create a list based on definition to show ALL steps in the sidebar
  return Object.keys(definition.value.nodes).map(id => {
    const state = stepStates.value[id]
    return {
      key: id,
      status: state?.status || 'idle',
      error: state?.error,
      result: state?.result
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
          <NuxtLink @click="push(`/workflows/runs`)" class="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-900 rounded-lg transition-colors cursor-pointer">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </NuxtLink>
          <div>
            <h1 class="text-xl font-bold text-zinc-900 dark:text-white flex items-center gap-2">
              Run: <span class="font-mono text-lg opacity-70">{{ (runId || '').slice(0, 8) }}...</span>
            </h1>
            <p class="text-xs text-zinc-500 dark:text-zinc-400">Execution detail and node status</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
           <span v-if="normalizedStatus" 
            class="px-3 py-1 rounded-full text-[10px] font-bold uppercase border shadow-sm"
            :class="normalizedStatus === 'completed' ? 'text-emerald-600 border-emerald-200 bg-emerald-50' : normalizedStatus === 'failed' ? 'text-red-600 border-red-200 bg-red-50' : 'text-blue-600 border-blue-200 bg-blue-50'"
           >
             {{ normalizedStatus }}
           </span>
           <button 
             @click="refresh" 
             class="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-900 rounded-lg transition-colors text-zinc-500"
             :class="{ 'animate-spin': pending }"
           >
             <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
           </button>
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
