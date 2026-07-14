<template>
  <div class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
    <!-- Card header row -->
    <button
      type="button"
      class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
      @click="$emit('toggle')"
    >
      <div
        class="w-2 h-2 rounded-full shrink-0"
        :class="statusDot(worker.status)"
      />
      <UIcon
        :name="runtimeIcon(worker.runtime)"
        class="w-4 h-4 shrink-0"
        :class="runtimeIconClass(worker.runtime)"
      />
      <span class="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate flex-1 min-w-0">
        {{ worker.name }}
      </span>
      <!-- Active invocations pulse -->
      <span
        v-if="worker.active_invocations > 0"
        class="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 shrink-0"
      >
        <div class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
        {{ worker.active_invocations }} active
      </span>
      <span class="text-xs text-gray-400 shrink-0 hidden sm:block">
        {{ worker.function_count }} fn{{ worker.function_count !== 1 ? 's' : '' }}
      </span>
      <span
        v-if="worker.version"
        class="text-xs text-gray-400 font-mono shrink-0 hidden md:block"
      >v{{ worker.version }}</span>
      <span class="text-xs text-gray-400 shrink-0">
        <ClientOnly>
          {{ formatRelativeTime(worker.connected_at_ms) }}
          <template #fallback>
            Connected
          </template>
        </ClientOnly>
      </span>
      <UIcon
        :name="isExpanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        class="w-3.5 h-3.5 text-gray-400 shrink-0"
      />
    </button>

    <!-- Expanded detail -->
    <div
      v-if="isExpanded"
      class="border-t border-gray-100 dark:border-gray-800 px-4 pb-4"
    >
      <!-- System info -->
      <div class="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-xs">
        <span v-if="worker.isolation">
          <span class="font-medium text-gray-600 dark:text-gray-300">ISOLATION </span>
          <span class="text-gray-500 dark:text-gray-400 capitalize">{{ worker.isolation }}</span>
        </span>
        <span v-if="worker.os">
          <span class="font-medium text-gray-600 dark:text-gray-300">OS </span>
          <span class="text-gray-500 dark:text-gray-400">{{ worker.os }}</span>
        </span>
        <span v-if="worker.pid != null">
          <span class="font-medium text-gray-600 dark:text-gray-300">PID </span>
          <span class="text-gray-500 dark:text-gray-400 font-mono">{{ worker.pid }}</span>
        </span>
        <span v-if="worker.ip_address">
          <span class="font-medium text-gray-600 dark:text-gray-300">IP </span>
          <span class="text-gray-500 dark:text-gray-400 font-mono">{{ worker.ip_address }}</span>
        </span>
        <span class="text-gray-300 dark:text-gray-600 font-mono">{{ worker.id }}</span>
      </div>

      <p
        v-if="worker.description"
        class="mt-3 text-xs text-gray-600 dark:text-gray-400 leading-relaxed max-w-2xl"
      >
        {{ worker.description }}
      </p>

      <!-- Resource metrics -->
      <div
        v-if="worker.latest_metrics"
        class="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3"
      >
        <!-- CPU -->
        <div class="rounded-md bg-gray-50 dark:bg-gray-800/50 p-2.5">
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-xs font-medium text-gray-500 dark:text-gray-400">CPU</span>
            <span class="text-xs font-mono font-semibold text-gray-800 dark:text-gray-200">{{ worker.latest_metrics.cpu_percent.toFixed(1) }}%</span>
          </div>
          <div class="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-500"
              :class="worker.latest_metrics.cpu_percent > 80 ? 'bg-red-500' : worker.latest_metrics.cpu_percent > 50 ? 'bg-amber-500' : 'bg-emerald-500'"
              :style="{ width: `${Math.min(worker.latest_metrics.cpu_percent, 100)}%` }"
            />
          </div>
        </div>
        <!-- Heap -->
        <div class="rounded-md bg-gray-50 dark:bg-gray-800/50 p-2.5">
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-xs font-medium text-gray-500 dark:text-gray-400">Heap</span>
            <span class="text-xs font-mono font-semibold text-gray-800 dark:text-gray-200">{{ formatBytes(worker.latest_metrics.memory_heap_used) }} / {{ formatBytes(worker.latest_metrics.memory_heap_total) }}</span>
          </div>
          <div class="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              class="h-full bg-blue-500 rounded-full transition-all duration-500"
              :style="{ width: `${Math.min(worker.latest_metrics.memory_heap_used / worker.latest_metrics.memory_heap_total * 100, 100)}%` }"
            />
          </div>
        </div>
        <!-- RSS -->
        <div class="rounded-md bg-gray-50 dark:bg-gray-800/50 p-2.5">
          <span class="text-xs font-medium text-gray-500 dark:text-gray-400">RSS</span>
          <p class="text-xs font-mono font-semibold text-gray-800 dark:text-gray-200 mt-0.5">
            {{ formatBytes(worker.latest_metrics.memory_rss) }}
          </p>
        </div>
        <!-- Event loop lag -->
        <div class="rounded-md bg-gray-50 dark:bg-gray-800/50 p-2.5">
          <span class="text-xs font-medium text-gray-500 dark:text-gray-400">Event loop lag</span>
          <p
            class="text-xs font-mono font-semibold mt-0.5"
            :class="worker.latest_metrics.event_loop_lag_ms > 100 ? 'text-red-500' : worker.latest_metrics.event_loop_lag_ms > 20 ? 'text-amber-500' : 'text-gray-800 dark:text-gray-200'"
          >
            {{ worker.latest_metrics.event_loop_lag_ms.toFixed(2) }} ms
          </p>
        </div>
      </div>

      <!-- Functions list -->
      <div
        v-if="worker.functions && worker.functions.length"
        class="mt-4"
      >
        <p class="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">
          Functions ({{ worker.functions.length }})
        </p>
        <div class="space-y-1">
          <NventWorkerFunctionItem
            v-for="fn in worker.functions"
            :key="fn"
            :function-id="fn"
          />
        </div>
      </div>
      <p
        v-else
        class="mt-3 text-xs text-gray-400"
      >
        No functions registered
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { WorkerInfo } from '../../composables/useWorkers'

defineProps<{
  worker: WorkerInfo
  isExpanded: boolean
}>()

defineEmits(['toggle'])

function statusDot(status: string | undefined | null): string {
  if (status === 'connected' || status === 'idle' || status === 'available') return 'bg-emerald-500'
  if (status === 'disconnected') return 'bg-red-500'
  return 'bg-gray-400'
}

function runtimeIcon(runtime: string | null | undefined): string {
  if (runtime === 'node') return 'i-devicon-nodejs'
  if (runtime === 'python') return 'i-devicon-python'
  if (runtime === 'rust') return 'i-devicon-rust'
  if (runtime === 'engine') return 'i-lucide-settings'
  return 'i-lucide-cpu'
}

function runtimeIconClass(runtime: string | null | undefined): string {
  if (runtime === 'node') return 'text-emerald-500'
  if (runtime === 'python') return 'text-blue-500'
  if (runtime === 'rust') return 'text-orange-500'
  if (runtime === 'engine') return 'text-purple-500'
  return 'text-gray-400'
}
</script>
