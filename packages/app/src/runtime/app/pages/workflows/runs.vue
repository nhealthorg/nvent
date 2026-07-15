<script setup lang="ts">
import { computed, useFetch, useComponentRouter, onMounted, onUnmounted } from '#imports'

const { data, refresh, pending } = useFetch('/api/_workflows/runs')
const { push } = useComponentRouter()

const runs = computed(() => data.value?.runs || [])

// Auto-refresh every 5 seconds to show live updates
let refreshInterval: any = null
onMounted(() => {
  refreshInterval = setInterval(() => {
    refresh()
  }, 5000)
})

onUnmounted(() => {
  if (refreshInterval) clearInterval(refreshInterval)
})

function getStatusColor(status: string) {
  switch (status) {
    case 'completed':
    case 'done': 
      return 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/10 border-emerald-100 dark:border-emerald-900/20'
    case 'failed':
    case 'error':
      return 'text-red-600 bg-red-50 dark:bg-red-900/10 border-red-100 dark:border-red-900/20'
    case 'running':
    case 'active':
      return 'text-blue-600 bg-blue-50 dark:bg-blue-900/10 border-blue-100 dark:border-blue-900/20 animate-pulse'
    default: return 'text-zinc-600 bg-zinc-50 dark:bg-zinc-900/10 border-zinc-100 dark:border-zinc-900/20'
  }
}

function formatDate(timestamp: number) {
  if (!timestamp) return 'n/a'
  return new Date(timestamp).toLocaleString()
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Header -->
    <div class="border-b border-zinc-200 dark:border-zinc-800 px-6 py-4 shrink-0 bg-white dark:bg-zinc-950">
      <div class="flex items-center justify-between max-w-7xl mx-auto w-full">
        <div class="flex items-center gap-4">
          <NuxtLink @click="push(`/workflows`)" class="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-900 rounded-lg transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </NuxtLink>
          <div>
            <h1 class="text-xl font-bold text-zinc-900 dark:text-white">
              Workflow Runs
            </h1>
            <p class="text-xs text-zinc-500 dark:text-zinc-400">History of all executed pipelines</p>
          </div>
        </div>
        <button 
          @click="refresh" 
          class="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-900 rounded-lg transition-colors text-zinc-500"
          :class="{ 'animate-spin': pending }"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
        </button>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 min-h-0 overflow-y-auto">
      <div class="max-w-7xl mx-auto p-6">
        <div class="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden shadow-sm">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="bg-zinc-50 dark:bg-zinc-900/50 text-zinc-500 dark:text-zinc-400 text-xs font-medium uppercase tracking-wider">
                <th class="px-6 py-3 border-b border-zinc-200 dark:border-zinc-800">Run ID</th>
                <th class="px-6 py-3 border-b border-zinc-200 dark:border-zinc-800">Status</th>
                <th class="px-6 py-3 border-b border-zinc-200 dark:border-zinc-800">Started</th>
                <th class="px-6 py-3 border-b border-zinc-200 dark:border-zinc-800">Last Update</th>
                <th class="px-6 py-3 border-b border-zinc-200 dark:border-zinc-800"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-zinc-200 dark:divide-zinc-800">
              <tr 
                v-for="run in runs" 
                :key="run.run_id"
                class="hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors group cursor-pointer"
                @click="push(`/workflows/runs/${run.run_id}`)"
              >
                <td class="px-6 py-4">
                  <div class="flex flex-col">
                    <span class="text-sm font-mono font-medium text-zinc-900 dark:text-white truncate max-w-[200px]">
                      {{ run.run_id }}
                    </span>
                    <span class="text-[10px] text-zinc-500">Step {{ run.step }}</span>
                  </div>
                </td>
                <td class="px-6 py-4">
                  <span 
                    class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border"
                    :class="getStatusColor(run.status)"
                  >
                    {{ run.status }}
                  </span>
                </td>
                <td class="px-6 py-4 text-xs text-zinc-600 dark:text-zinc-400">
                  {{ formatDate(run.created_at) }}
                </td>
                <td class="px-6 py-4 text-xs text-zinc-600 dark:text-zinc-400">
                  {{ formatDate(run.updated_at) }}
                </td>
                <td class="px-6 py-4 text-right">
                  <svg class="w-4 h-4 text-zinc-400 group-hover:text-zinc-900 dark:group-hover:text-white transition-colors ml-auto" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                </td>
              </tr>
              <tr v-if="runs.length === 0 && !pending">
                <td colspan="5" class="px-6 py-12 text-center text-zinc-500 dark:text-zinc-400 italic text-sm">
                  No workflow runs found.
                </td>
              </tr>
              <tr v-if="pending && runs.length === 0">
                <td colspan="5" class="px-6 py-12 text-center text-zinc-500 dark:text-zinc-400 text-sm">
                   <div class="w-6 h-6 border-2 border-zinc-200 border-t-zinc-800 rounded-full animate-spin mx-auto mb-2"></div>
                   Loading runs...
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
