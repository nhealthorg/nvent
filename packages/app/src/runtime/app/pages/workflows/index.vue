<script setup lang="ts">
import { useWorkflows, computed, useComponentRouter, ref, useFetch, onMounted, onUnmounted } from '#imports'
const { push } = useComponentRouter()
const { definitions, loading, error } = useWorkflows()

const { data: activeRunsData, refresh: refreshActiveRuns } = useFetch<any>('/api/_workflows/runs', {
  query: { status: 'awaiting_nodes', limit: 1 }
})

const stats = computed(() => [
  { label: 'Registered', count: definitions.value.length, icon: 'i-lucide-list' },
  { label: 'Active Runs', count: activeRunsData.value?.pagination?.total || 0, icon: 'i-lucide-play', variant: 'blue' as const },
  { label: 'Triggers', count: definitions.value.reduce((acc, w) => acc + (w.triggers?.length || 0), 0), icon: 'i-lucide-zap', variant: 'amber' as const }
])

const isTriggerOpen = ref(false)
const selectedWorkflow = ref<any>(null)

let refreshInterval: any = null
onMounted(() => {
  refreshInterval = setInterval(() => {
    refreshActiveRuns()
  }, 10000)
})

onUnmounted(() => {
  if (refreshInterval) clearInterval(refreshInterval)
})

function openWorkflow(workflow: any) {
  push(`/workflows/runs?workflow=${workflow.id}`)
}

function startTrigger(workflow: any) {
  selectedWorkflow.value = workflow
  isTriggerOpen.value = true
}

function onTriggered(event: { workflowId: string, runId: string }) {
  console.log('Workflow triggered:', event.workflowId, event.runId)
  // Navigate to the run details
  push(`/workflows/runs/${event.runId}`)
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Header -->
    <div class="border-b border-zinc-200 dark:border-zinc-800 px-6 py-4 shrink-0 bg-white dark:bg-zinc-950">
      <div class="flex items-center justify-between max-w-7xl mx-auto w-full">
        <div>
          <h1 class="text-xl font-bold text-zinc-900 dark:text-white">
            Workflows
          </h1>
          <p class="text-xs text-zinc-500 dark:text-zinc-400">Manage and monitor orchestration pipelines</p>
        </div>
        <div class="flex items-center gap-3">
          <UButton
            icon="i-heroicons-clock"
            color="neutral"
            variant="outline"
            label="Workflow Runs"
            @click="push('/workflows/runs')"
          />
        </div>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 min-h-0 overflow-y-auto">
      <div class="max-w-7xl mx-auto p-6 space-y-8">
        
        <!-- Quick Stats -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <NventStatCard 
            v-for="stat in stats" 
            :key="stat.label"
            :label="stat.label"
            :count="stat.count"
            :icon="stat.icon"
            :variant="stat.variant"
          />
        </div>

        <!-- Transitions Grid -->
        <ClientOnly>
          <div v-if="loading && definitions.length === 0" class="py-20 flex flex-col items-center justify-center text-center">
            <div class="w-10 h-10 border-4 border-zinc-200 border-t-zinc-800 rounded-full animate-spin mb-4"></div>
            <p class="text-zinc-500 text-sm">Loading workflows...</p>
          </div>

          <div v-else-if="error" class="p-6 bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/20 rounded-xl">
            <p class="text-red-600 dark:text-red-400 font-medium">Error loading workflows</p>
            <p class="text-sm text-red-500 mt-1">{{ error.message || error }}</p>
          </div>

          <div v-else-if="definitions.length > 0" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <NventWorkflowCard 
              v-for="workflow in definitions" 
              :key="workflow.id"
              :workflow="workflow"
              @details="openWorkflow"
              @trigger="startTrigger"
            />
          </div>

          <div v-else class="py-24 flex flex-col items-center justify-center text-center border-2 border-dashed border-zinc-200 dark:border-zinc-800 rounded-3xl">
            <div class="w-16 h-16 bg-zinc-100 dark:bg-zinc-900 rounded-2xl flex items-center justify-center text-zinc-400 dark:text-zinc-600 mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21l0 -4"/><path d="M14 21l0 -4"/><path d="M21 21l0 -4"/><path d="M7 3v3h10V3"/><path d="M10 14 5 14 5 6h14v8h-5"/><path d="m10 14 4 0"/></svg>
            </div>
            <h3 class="text-lg font-semibold text-zinc-900 dark:text-white">No workflows found</h3>
            <p class="text-zinc-500 dark:text-zinc-400 mt-1 max-w-xs text-sm">
              Workflows defined in your playground or layers will automatically appear here once registered.
            </p>
          </div>
          
          <template #fallback>
            <div class="py-20 flex flex-col items-center justify-center text-center">
              <div class="w-10 h-10 border-4 border-zinc-200 border-t-zinc-800 rounded-full animate-spin mb-4"></div>
              <p class="text-zinc-500 text-sm">Initializing...</p>
            </div>
          </template>
        </ClientOnly>

      </div>
    </div>

    <!-- Trigger Slideover -->
    <NventWorkflowTriggerSlideover
      v-model="isTriggerOpen"
      :workflow="selectedWorkflow"
      @triggered="onTriggered"
    />
  </div>
</template>

