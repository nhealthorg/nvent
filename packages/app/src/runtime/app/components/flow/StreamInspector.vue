<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="px-6 py-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 shrink-0 space-y-3">
      <div class="flex items-start justify-between gap-4">
        <div class="space-y-1 min-w-0">
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-waves"
              class="w-4 h-4 text-gray-400"
            />
            <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Workflow Streams
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
            <span v-if="isLoading">Loading streams...</span>
            <span v-else-if="errorMessage">Unable to load streams</span>
            <span v-else>{{ streamEntries.length }} stream group(s), {{ totalMessageCount }} message(s)</span>
          </p>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <div class="flex-1 relative">
          <UIcon
            name="i-lucide-search"
            class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
          />
          <input
            v-model="filterText"
            type="text"
            placeholder="Filter by stream name, node or payload..."
            class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400"
          />
        </div>
      </div>
    </div>

    <div class="flex-1 overflow-hidden flex flex-col">
      <div v-if="isLoading" class="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
        <div class="text-center space-y-3">
          <div class="w-10 h-10 border-4 border-gray-200 border-t-gray-800 rounded-full animate-spin mx-auto" />
          <span class="text-sm">Loading stream events...</span>
        </div>
      </div>

      <div v-else-if="errorMessage" class="flex-1 flex items-center justify-center text-red-500 dark:text-red-400 px-6 text-center">
        <div class="space-y-2">
          <UIcon name="i-lucide-alert-triangle" class="w-10 h-10 mx-auto opacity-70" />
          <p class="text-sm font-medium">{{ errorMessage }}</p>
          <p class="text-xs text-gray-500 dark:text-gray-400">No readable stream traces available for this run.</p>
        </div>
      </div>

      <div v-else-if="filteredStreams.length === 0" class="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
        <div class="text-center">
          <UIcon name="i-lucide-inbox" class="w-12 h-12 mb-3 opacity-50 mx-auto" />
          <span class="text-sm">{{ filterText ? 'No matching streams' : 'No stream data for this run' }}</span>
        </div>
      </div>

      <div v-else class="overflow-y-auto overflow-x-hidden flex-1 bg-gradient-to-b from-white to-gray-50/70 dark:from-zinc-950 dark:to-zinc-900/30">
        <div class="px-4 py-4 space-y-3">
          <div
            v-for="(stream, idx) in filteredStreams"
            :key="stream.streamName"
            class="group rounded-xl border border-gray-200/80 dark:border-gray-800 bg-white/90 dark:bg-zinc-900/40 shadow-sm overflow-hidden"
          >
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

              <div class="min-w-0 flex-1 space-y-1">
                <div class="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate tracking-tight">
                  {{ stream.streamName }}
                </div>
                <div class="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {{ stream.items.length }} message(s)
                </div>
              </div>

            </div>

            <div
              v-if="isExpanded(idx)"
              class="px-4 py-3 bg-gray-50/70 dark:bg-zinc-900/60 border-t border-gray-200 dark:border-gray-800 space-y-3"
            >
              <div
                v-for="message in stream.items"
                :key="message.id"
                class="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-zinc-950/80"
              >
                <div class="px-3 py-2 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between gap-3">
                  <div class="flex items-center gap-2 min-w-0 flex-wrap">
                    <span class="text-[11px] font-mono text-gray-900 dark:text-gray-100 truncate max-w-[220px]">
                      {{ message.item_id || message.id }}
                    </span>
                    <span
                      v-if="message.node_uid"
                      class="rounded-md bg-gray-100 dark:bg-zinc-800 px-2 py-0.5 text-[10px] font-mono text-gray-600 dark:text-gray-300"
                    >
                      node {{ message.node_uid }}
                    </span>
                    <span
                      v-if="message.function_id"
                      class="rounded-md bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 text-[10px] font-mono text-blue-700 dark:text-blue-300"
                    >
                      {{ message.function_id }}
                    </span>
                  </div>
                </div>
                <div class="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words max-h-64 overflow-auto leading-5">
                  {{ prettyMessage(message.data) }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, useFetch, onMounted, onUnmounted, watch } from '#imports'

type StreamMessage = {
  id: string
  item_id?: string
  run_id?: string
  node_uid?: string
  function_id?: string
  ts_unix_ms?: number
  event_name?: string
  data?: unknown
}

type StreamGroup = {
  streamName: string
  items: StreamMessage[]
}

interface WorkflowStreamsResponse {
  streams?: StreamGroup[]
}

const props = defineProps<{
  runId: string
  isLive?: boolean
}>()

const filterText = ref('')
const expanded = ref<Set<number>>(new Set())
const refreshTick = ref(0)

const {
  data: streamsData,
  pending: streamsPending,
  error: streamsFetchError,
  execute: executeStreamsFetch,
} = useFetch<WorkflowStreamsResponse>('/api/_workflows/streams', {
  query: computed(() => ({
    run_id: props.runId,
    _t: refreshTick.value,
  })),
  immediate: false,
  server: false,
  watch: false,
})

const isLoading = computed(() => streamsPending.value)
const errorMessage = computed(() => {
  if (!streamsFetchError.value) return null
  return 'Stream references could not be loaded'
})

async function refreshStreams() {
  expanded.value.clear()
  refreshTick.value += 1
  await executeStreamsFetch()
}

const streamEntries = computed(() => {
  const groups = Array.isArray(streamsData.value?.streams) ? streamsData.value.streams : []
  return groups
    .map((stream) => ({
      streamName: stream.streamName || '',
      items: Array.isArray(stream.items)
        ? [...stream.items].sort((a, b) => Number(b.ts_unix_ms || 0) - Number(a.ts_unix_ms || 0))
        : [],
    }))
    .filter(entry => Boolean(entry.streamName))
    .sort((a, b) => Number(b.items[0]?.ts_unix_ms || 0) - Number(a.items[0]?.ts_unix_ms || 0))
})

const totalMessageCount = computed(() => {
  return streamEntries.value.reduce((sum, stream) => sum + stream.items.length, 0)
})

const filteredStreams = computed(() => {
  if (!filterText.value) return streamEntries.value
  const query = filterText.value.toLowerCase()

  return streamEntries.value
    .map((stream) => {
      const matchesGroup = stream.streamName.toLowerCase().includes(query)
      if (matchesGroup) return stream

      const items = stream.items.filter((item) => {
        const payload = prettyMessage(item.data).toLowerCase()
        const node = String(item.node_uid || '').toLowerCase()
        const functionId = String(item.function_id || '').toLowerCase()
        return payload.includes(query) || node.includes(query) || functionId.includes(query)
      })

      return {
        streamName: stream.streamName,
        items,
      }
    })
    .filter(stream => stream.items.length > 0 || stream.streamName.toLowerCase().includes(query))
})

function toggleExpanded(idx: number) {
  if (expanded.value.has(idx)) {
    expanded.value.delete(idx)
  }
  else {
    expanded.value.add(idx)
  }
}

function isExpanded(idx: number): boolean {
  return expanded.value.has(idx)
}

function prettyMessage(value: unknown): string {
  try {
    if (typeof value === 'string') return value
    return JSON.stringify(value, null, 2)
  }
  catch {
    return String(value)
  }
}

let refreshInterval: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  void refreshStreams()
  refreshInterval = setInterval(() => {
    if (props.isLive) {
      void refreshStreams()
    }
  }, 3000)
})

onUnmounted(() => {
  if (refreshInterval) clearInterval(refreshInterval)
})

watch(() => props.runId, () => {
  void refreshStreams()
})
</script>
