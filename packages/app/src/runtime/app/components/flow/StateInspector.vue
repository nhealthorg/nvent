<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- Header -->
    <div class="px-6 py-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 shrink-0 space-y-3">
      <div class="flex items-start justify-between gap-4">
        <div class="space-y-1 min-w-0">
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-database"
              class="w-4 h-4 text-gray-400"
            />
            <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Workflow State
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
            <span v-if="isLoading">Loading states...</span>
            <span v-else-if="errorMessage">Unable to load states</span>
            <span v-else>{{ stateEntries.length }} key/value pair(s) persisted</span>
          </p>
        </div>

        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-download"
          :disabled="stateEntries.length === 0 || isLoading"
          @click="exportStates"
        >
          Export
        </UButton>
      </div>

      <!-- Search/Filter -->
      <div class="flex items-center gap-2">
        <div class="flex-1 relative">
          <UIcon
            name="i-lucide-search"
            class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
          />
          <input
            v-model="filterText"
            type="text"
            placeholder="Filter by key..."
            class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400"
          />
        </div>
      </div>
    </div>

    <!-- State Table -->
    <div class="flex-1 overflow-hidden flex flex-col">
      <div v-if="isLoading" class="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
        <div class="text-center space-y-3">
          <div class="w-10 h-10 border-4 border-gray-200 border-t-gray-800 rounded-full animate-spin mx-auto" />
          <span class="text-sm">Loading state values...</span>
        </div>
      </div>

      <div v-else-if="errorMessage" class="flex-1 flex items-center justify-center text-red-500 dark:text-red-400 px-6 text-center">
        <div class="space-y-2">
          <UIcon name="i-lucide-alert-triangle" class="w-10 h-10 mx-auto opacity-70" />
          <p class="text-sm font-medium">{{ errorMessage }}</p>
          <p class="text-xs text-gray-500 dark:text-gray-400">The workflow worker returned no readable state payload.</p>
        </div>
      </div>

      <div v-else-if="filteredStates.length === 0" class="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
        <div class="text-center">
          <UIcon name="i-lucide-inbox" class="w-12 h-12 mb-3 opacity-50 mx-auto" />
          <span class="text-sm">{{ filterText ? 'No matching states' : 'No state data for this run' }}</span>
        </div>
      </div>

      <div v-else class="overflow-y-auto overflow-x-hidden flex-1">
        <div class="divide-y divide-gray-200 dark:divide-gray-800">
          <div
            v-for="(item, idx) in filteredStates"
            :key="item.key || idx"
            class="group hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors"
          >
            <!-- State Row -->
            <div
              class="px-4 py-3 cursor-pointer flex items-center gap-3"
              @click="toggleExpanded(idx)"
            >
              <div class="w-4 flex items-center justify-center shrink-0">
                <UIcon
                  :name="isExpanded(idx) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                  class="w-4 h-4 text-gray-400 transition-transform"
                />
              </div>

              <div class="min-w-0 flex-1">
                <div class="text-sm font-mono text-gray-900 dark:text-gray-100 truncate">
                  {{ item.key }}
                </div>
                <div class="mt-1 text-xs text-gray-500 dark:text-gray-400 truncate">
                  {{ getValuePreview(item.value) }}
                </div>
              </div>

              <!-- Type Badge -->
              <div class="shrink-0">
                <span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                  {{ getValueType(item.value) }}
                </span>
              </div>

              <!-- Preview -->
              <div class="shrink-0 text-xs text-gray-500 dark:text-gray-400 max-w-[120px] truncate">
                {{ getValuePreview(item.value) }}
              </div>
            </div>

            <!-- Expanded Content -->
            <div
              v-if="isExpanded(idx)"
              class="px-4 py-3 bg-gray-100/50 dark:bg-gray-900/50 border-t border-gray-200 dark:border-gray-800"
            >
              <div class="font-mono text-xs">
                <pre class="whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-950 p-3 rounded border border-gray-200 dark:border-gray-800 max-h-64 overflow-auto">{{ JSON.stringify(item.value, null, 2) }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, useFetch, watch, onMounted, onUnmounted } from '#imports'

interface StateItem {
  key: string
  value: unknown
}

interface WorkflowStatesResponse {
  states?: Array<Record<string, unknown>>
}

const props = defineProps<{
  runId: string
  isLive?: boolean
}>()

const filterText = ref('')
const expanded = ref<Set<number>>(new Set())
const refreshTick = ref(0)

const {
  data: statesData,
  pending: statesPending,
  error: statesFetchError,
  execute: executeStatesFetch,
} = useFetch<WorkflowStatesResponse>('/api/_workflows/states', {
  query: computed(() => ({
    run_id: props.runId,
    limit: 1000,
    _t: refreshTick.value,
  })),
  immediate: false,
  server: false,
  watch: false,
})

const isLoading = computed(() => statesPending.value)
const errorMessage = computed(() => {
  if (!statesFetchError.value) return null
  return 'State data could not be loaded'
})

async function refreshStates() {
  expanded.value.clear()
  refreshTick.value += 1
  await executeStatesFetch()
}

const stateEntries = computed<StateItem[]>(() => {
  const list = Array.isArray(statesData.value?.states) ? statesData.value?.states : []
  return list
    .map((item, index) => {
      const key = String(item.key || item.id || item.name || item.state_key || `state-${index + 1}`)
      const value = (item.value ?? item.data ?? item.state_value ?? item.payload ?? item) as unknown
      return { key, value }
    })
    .sort((left, right) => left.key.localeCompare(right.key))
})

const filteredStates = computed(() => {
  if (!filterText.value) return stateEntries.value
  const query = filterText.value.toLowerCase()
  return stateEntries.value.filter(entry => {
    const preview = getValuePreview(entry.value).toLowerCase()
    return entry.key.toLowerCase().includes(query) || preview.includes(query)
  })
})

function toggleExpanded(idx: number) {
  if (expanded.value.has(idx)) {
    expanded.value.delete(idx)
  } else {
    expanded.value.add(idx)
  }
}

function isExpanded(idx: number) {
  return expanded.value.has(idx)
}

function getValueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array[${value.length}]`
  if (typeof value === 'object') return 'object'
  return typeof value
}

function getValuePreview(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return `"${value.slice(0, 30)}${value.length > 30 ? '...' : ''}"`
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.length} items]`
  if (typeof value === 'object') return '{...}'
  return '?'
}

function exportStates() {
  const data = stateEntries.value.map(item => ({ key: item.key, value: item.value }))
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `workflow-states-${props.runId}-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
}

let refreshInterval: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  void refreshStates()
  refreshInterval = setInterval(() => {
    if (props.isLive) {
      void refreshStates()
    }
  }, 3000)
})

onUnmounted(() => {
  if (refreshInterval) clearInterval(refreshInterval)
})

watch(() => props.runId, () => {
  void refreshStates()
})
</script>
