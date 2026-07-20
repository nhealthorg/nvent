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
            <span v-else>{{ streamEntries.length }} stream(s) loaded</span>
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
            placeholder="Filter by stream name..."
            class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400"
          />
        </div>
      </div>
    </div>

    <div class="flex-1 overflow-hidden flex flex-col">
      <div v-if="isLoading" class="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
        <div class="text-center space-y-3">
          <div class="w-10 h-10 border-4 border-gray-200 border-t-gray-800 rounded-full animate-spin mx-auto" />
          <span class="text-sm">Loading stream references...</span>
        </div>
      </div>

      <div v-else-if="errorMessage" class="flex-1 flex items-center justify-center text-red-500 dark:text-red-400 px-6 text-center">
        <div class="space-y-2">
          <UIcon name="i-lucide-alert-triangle" class="w-10 h-10 mx-auto opacity-70" />
          <p class="text-sm font-medium">{{ errorMessage }}</p>
          <p class="text-xs text-gray-500 dark:text-gray-400">The workflow worker did not return any stream references.</p>
        </div>
      </div>

      <div v-else-if="filteredStreams.length === 0" class="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
        <div class="text-center">
          <UIcon name="i-lucide-inbox" class="w-12 h-12 mb-3 opacity-50 mx-auto" />
          <span class="text-sm">{{ filterText ? 'No matching streams' : 'No stream data for this run' }}</span>
        </div>
      </div>

      <div v-else class="overflow-y-auto overflow-x-hidden flex-1">
        <div class="px-4 py-4 space-y-4">
          <div
            v-for="(stream, idx) in filteredStreams"
            :key="stream.streamName"
            class="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 overflow-hidden"
          >
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between gap-3">
              <div class="min-w-0 flex items-center gap-2">
                <UIcon name="i-lucide-waves" class="w-4 h-4 text-gray-400 shrink-0" />
                <div class="min-w-0">
                  <div class="text-sm font-mono text-gray-900 dark:text-gray-100 truncate">
                    {{ stream.streamName }}
                  </div>
                  <div class="text-xs text-gray-500 dark:text-gray-400">
                    {{ stream.items.length }} message(s)
                  </div>
                </div>
              </div>

              <div class="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                #{{ idx + 1 }}
              </div>
            </div>

            <div class="divide-y divide-gray-200 dark:divide-gray-800">
              <div
                v-for="message in stream.items"
                :key="message.id"
                class="px-4 py-3 space-y-2"
              >
                <div class="flex items-center justify-between gap-3">
                  <div class="flex flex-wrap items-center gap-2 min-w-0">
                    <span class="text-xs font-mono text-gray-900 dark:text-gray-100 truncate">
                      {{ message.item_id || message.id }}
                    </span>
                    <span v-if="message.node_uid" class="rounded bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-[10px] font-mono text-gray-600 dark:text-gray-300">node {{ message.node_uid }}</span>
                    <span v-if="message.function_id" class="rounded bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-[10px] font-mono text-gray-600 dark:text-gray-300">fn {{ message.function_id }}</span>
                  </div>
                  <div class="text-[11px] text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {{ formatTimestamp(Number(message.ts_unix_ms || 0)) }}
                  </div>
                </div>

                <div class="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/70 px-3 py-2 text-xs text-gray-700 dark:text-gray-200 font-mono whitespace-pre-wrap break-words max-h-44 overflow-auto">
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
import { ref, computed } from '#imports'

type StreamMessage = {
  id: string
  item_id?: string
  run_id?: string
  node_uid?: string
  function_id?: string
  ts_unix_ms?: number
  data?: unknown
}

type StreamGroup = {
  streamName: string
  items: StreamMessage[]
}

const props = defineProps<{
  streams: StreamGroup[]
  isLive?: boolean
  isLoading?: boolean
  errorMessage?: string | null
}>()

const filterText = ref('')

const streamEntries = computed(() => {
  return props.streams
    .map((stream) => {
      return {
        streamName: stream.streamName || '',
        items: Array.isArray(stream.items) ? stream.items : [],
      }
    })
    .filter(entry => Boolean(entry.streamName))
})

const filteredStreams = computed(() => {
  if (!filterText.value) return streamEntries.value
  const query = filterText.value.toLowerCase()
  return streamEntries.value.filter(stream => {
    if (stream.streamName.toLowerCase().includes(query)) return true
    return stream.items.some(item => prettyMessage(item.data).toLowerCase().includes(query))
  })
})

function prettyMessage(value: unknown): string {
  try {
    if (typeof value === 'string') return value
    return JSON.stringify(value, null, 2)
  }
  catch {
    return String(value)
  }
}

function formatTimestamp(ts: number) {
  if (!ts) return 'unknown'
  return new Date(ts).toLocaleTimeString()
}
</script>
