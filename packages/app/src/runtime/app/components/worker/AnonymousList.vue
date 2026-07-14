<template>
  <div v-if="workers.length">
    <div class="flex items-center gap-2 mt-4 mb-1">
      <div class="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
      <span class="text-xs text-gray-400 shrink-0">{{ workers.length }} anonymous connection(s)</span>
      <div class="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
    </div>
    <div
      v-for="worker in workers"
      :key="worker.id"
      class="bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-dashed border-gray-200 dark:border-gray-800 px-4 py-2.5 flex items-center gap-3 opacity-60"
    >
      <div
        class="w-2 h-2 rounded-full shrink-0"
        :class="statusDot(worker.status)"
      />
      <span class="text-xs text-gray-500 dark:text-gray-400 font-mono flex-1 truncate">{{ worker.id }}</span>
      <span class="text-xs text-gray-400">{{ formatRelativeTime(worker.connected_at_ms) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { WorkerInfo } from '../../composables/useWorkers'

defineProps<{
  workers: WorkerInfo[]
}>()

function statusDot(status: string | undefined | null): string {
  if (status === 'connected' || status === 'idle' || status === 'available') return 'bg-emerald-500'
  if (status === 'disconnected') return 'bg-red-500'
  return 'bg-gray-400'
}
</script>
