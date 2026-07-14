<template>
  <div
    v-if="health"
    class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden"
  >
    <button
      type="button"
      class="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
      @click="isExpanded = !isExpanded"
    >
      <UIcon
        name="i-lucide-heart-pulse"
        class="w-4 h-4 text-emerald-500 shrink-0"
      />
      <h2 class="text-sm font-semibold flex-1">
        Engine Health
      </h2>
      <UBadge
        :color="health.status === 'healthy' ? 'success' : 'error'"
        variant="subtle"
        size="xs"
      >
        {{ health.status }}
      </UBadge>
      <span class="text-xs text-gray-400 mx-2 font-mono">v{{ health.version }}</span>
      <span class="text-xs text-gray-400 mr-1">
        <ClientOnly>
          updated {{ formatRelativeTime(health.timestamp) }}
          <template #fallback>
            Engine
          </template>
        </ClientOnly>
      </span>
      <UIcon
        :name="isExpanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        class="w-3.5 h-3.5 text-gray-400 shrink-0"
      />
    </button>
    <div
      v-if="isExpanded"
      class="border-t border-gray-100 dark:border-gray-800 px-4 pb-4"
    >
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
        <div
          v-for="(component, name) in health.components"
          :key="name"
          class="rounded-md border border-gray-100 dark:border-gray-800 p-2.5"
        >
          <div class="flex items-center gap-1.5 mb-1.5">
            <div
              class="w-1.5 h-1.5 rounded-full shrink-0"
              :class="component.status === 'healthy' ? 'bg-emerald-500' : 'bg-red-500'"
            />
            <span class="text-xs font-semibold capitalize">{{ name }}</span>
          </div>
          <div class="space-y-0.5">
            <div
              v-for="(val, key) in component.details"
              :key="key"
              class="flex items-center justify-between gap-2 text-xs"
            >
              <span class="text-gray-500 dark:text-gray-400 truncate">{{ String(key).replace(/_/g, ' ') }}</span>
              <span class="font-mono font-medium text-gray-700 dark:text-gray-200 shrink-0">{{ val }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from '#imports'
import type { EngineHealth } from '../../composables/useWorkers'

defineProps<{
  health: EngineHealth | null
}>()

const isExpanded = ref(true)
</script>
