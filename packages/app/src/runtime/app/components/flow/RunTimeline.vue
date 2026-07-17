<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="px-6 py-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 shrink-0 space-y-3">
      <div class="flex items-start justify-between gap-4">
        <div class="space-y-1 min-w-0">
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-activity"
              class="w-4 h-4 text-gray-400"
            />
            <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Run Timeline
            </span>
            <span
              v-if="isLive"
              class="flex items-center gap-1.5 ml-2"
            >
              <div class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span class="text-xs text-gray-500 dark:text-gray-400">Live</span>
            </span>
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            {{ selectedStep ? `Filtered to ${selectedStep}` : 'Showing the full workflow activity feed' }}
          </p>
        </div>

        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-download"
          :disabled="filteredItems.length === 0"
          @click="$emit('export')"
        >
          Export
        </UButton>
      </div>

      <div class="grid grid-cols-3 gap-2 text-[11px]">
        <div class="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-3 py-2">
          <div class="text-gray-500 dark:text-gray-400">Visible</div>
          <div class="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{{ filteredItems.length }}</div>
        </div>
        <div class="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-3 py-2">
          <div class="text-gray-500 dark:text-gray-400">Events</div>
          <div class="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{{ eventCount }}</div>
        </div>
        <div class="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-3 py-2">
          <div class="text-gray-500 dark:text-gray-400">Logs</div>
          <div class="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{{ logCount }}</div>
        </div>
      </div>

      <div class="flex flex-wrap gap-2 text-[11px]">
        <UBadge color="neutral" variant="soft">debug {{ debugCount }}</UBadge>
        <UBadge color="primary" variant="soft">info {{ infoCount }}</UBadge>
        <UBadge color="warning" variant="soft">warn {{ warnCount }}</UBadge>
        <UBadge color="error" variant="soft">error {{ errorCount }}</UBadge>
      </div>

      <div class="flex items-center justify-between gap-4 text-[11px]">
        <div class="flex items-center gap-1.5">
          <UIcon
            name="i-lucide-filter"
            class="w-3.5 h-3.5 text-gray-400"
          />
          <span class="text-gray-500 dark:text-gray-400">Stream:</span>
          <URadioGroup
            v-model="filter"
            :items="filterOptions"
            orientation="horizontal"
            size="xs"
            variant="table"
            indicator="hidden"
            :ui="{
              base: 'text-[9px]',
              container: 'gap-0',
              item: 'px-1 py-0',
            }"
          />
        </div>

        <div class="flex items-center gap-1.5">
          <UIcon
            name="i-lucide-badge-info"
            class="w-3.5 h-3.5 text-gray-400"
          />
          <span class="text-gray-600 dark:text-gray-300">
            {{ latestTimestampLabel }}
          </span>
        </div>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto overflow-x-hidden">
      <div
        v-if="filteredItems.length === 0"
        class="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500"
      >
        <UIcon
          name="i-lucide-inbox"
          class="w-12 h-12 mb-3 opacity-50"
        />
        <span class="text-sm">No {{ filter === 'all' ? 'items' : filter }} yet.</span>
      </div>
      <TimelineList
        v-else
        :items="filteredItems"
        height-class="min-h-full"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from '#imports'
import TimelineList from '../TimelineList.vue'

const props = defineProps<{
  events: any[]
  logs: any[]
  selectedStep?: string | null
  isLive?: boolean
}>()

defineEmits<{
  export: []
}>()

// Filter state: 'all', 'events', 'logs'
const filter = ref<'all' | 'events' | 'logs'>('all')

// Filter options for radio group
const filterOptions = [
  { value: 'all', label: 'All' },
  { value: 'events', label: 'Events' },
  { value: 'logs', label: 'Logs' },
]

const eventCount = computed(() => props.events.length)
const logCount = computed(() => props.logs.length)
const debugCount = computed(() => props.logs.filter(log => (log?.level || log?.data?.level || '').toLowerCase() === 'debug').length)
const infoCount = computed(() => props.logs.filter(log => (log?.level || log?.data?.level || '').toLowerCase() === 'info').length)
const warnCount = computed(() => props.logs.filter(log => (log?.level || log?.data?.level || '').toLowerCase() === 'warn').length)
const errorCount = computed(() => props.logs.filter(log => (log?.level || log?.data?.level || '').toLowerCase() === 'error').length)

// Helper function to create a unique hash for an item
function getItemHash(item: any): string {
  // For log events, use message + timestamp + stepName
  if (item.type === 'log') {
    const message = item.data?.message || item.data?.msg || ''
    const level = item.data?.level || 'info'
    const step = item.stepName || item.data?.stepName || ''
    const ts = item.ts || 0
    return `log-${ts}-${step}-${level}-${message}`.toLowerCase()
  }

  // For other events, use type + timestamp + stepName
  const step = item.stepName || ''
  const ts = item.ts || 0
  return `${item.type}-${ts}-${step}`.toLowerCase()
}

// Combine and filter items based on selection
const filteredItems = computed(() => {
  // First, combine ALL items (events and logs) and deduplicate
  const allItems: any[] = []

  // Add all events from events array
  allItems.push(...props.events)

  // Add logs (convert log format to event format)
  const logItems = props.logs.map(log => ({
    id: `log-${log.ts}`,
    ts: log.ts,
    type: 'log',
    stepName: log.step || log.stepName,
    level: log.level,
    message: log.message || log.msg,
    data: {
      level: log.level || log?.data?.level,
      message: log.message || log.msg || log?.data?.message,
      ...log.data,
    },
  }))
  allItems.push(...logItems)

  // Remove duplicates using content-based hashing
  const seenHashes = new Set<string>()
  const uniqueItems: any[] = []

  allItems.forEach((item) => {
    const hash = getItemHash(item)
    if (!seenHashes.has(hash)) {
      seenHashes.add(hash)
      uniqueItems.push(item)
    }
  })

  // Now apply the filter based on selection
  let deduplicatedItems = uniqueItems
  if (filter.value === 'events') {
    // Only show non-log events
    deduplicatedItems = uniqueItems.filter(item => item.type !== 'log')
  }
  else if (filter.value === 'logs') {
    // Only show log events
    deduplicatedItems = uniqueItems.filter(item => item.type === 'log')
  }
  // 'all' shows everything (no filtering needed)

  // Sort by timestamp (newest first)
  deduplicatedItems.sort((a, b) => {
    const getTs = (item: any) => {
      if (typeof item.ts === 'number') return item.ts
      if (typeof item.ts === 'string') return new Date(item.ts).getTime()
      return 0
    }
    return getTs(b) - getTs(a)
  })

  return deduplicatedItems
})

const latestTimestampLabel = computed(() => {
  const first = filteredItems.value[0]
  if (!first) return 'No activity yet'

  const ts = typeof first.ts === 'number' ? first.ts : new Date(first.ts).getTime()
  if (!Number.isFinite(ts)) return 'No activity yet'

  return `Latest update ${new Date(ts).toLocaleTimeString()}`
})
</script>
