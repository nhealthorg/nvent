<template>
  <div class="flex h-full min-h-0 flex-col bg-white dark:bg-zinc-950">
    <header class="shrink-0 border-b border-zinc-200 bg-zinc-50 px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900/50">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-waves" class="size-4 text-cyan-600 dark:text-cyan-400" />
            <h2 class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Run stream</h2>
            <span class="inline-flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              <span :class="statusDotClass" class="size-1.5 rounded-full" />
              {{ statusLabel }}
            </span>
          </div>
          <div class="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
            <span class="shrink-0">nworkflow /</span>
            <span class="truncate" :title="runId">{{ runId }}</span>
          </div>
        </div>
        <UBadge :label="`${events.length} events`" color="neutral" variant="soft" size="xs" />
      </div>

      <div class="relative mt-3">
        <UIcon name="i-lucide-search" class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
        <input
          v-model="filterText"
          type="search"
          placeholder="Filter type, node or payload"
          class="w-full rounded-md border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm text-zinc-900 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
      </div>

      <div v-if="eventTypes.length > 1" class="mt-3 flex gap-1.5 overflow-x-auto pb-0.5">
        <button type="button" class="shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium" :class="selectedType === null ? activeFilterClass : inactiveFilterClass" @click="selectedType = null">
          All
        </button>
        <button
          v-for="type in eventTypes"
          :key="type"
          type="button"
          class="shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium"
          :class="selectedType === type ? activeFilterClass : inactiveFilterClass"
          @click="selectedType = selectedType === type ? null : type"
        >
          {{ type }}
        </button>
      </div>
    </header>

    <div v-if="status === 'error' && events.length === 0" class="flex flex-1 items-center justify-center px-6 text-center">
      <div>
        <UIcon name="i-lucide-wifi-off" class="mx-auto size-9 text-red-500" />
        <p class="mt-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Stream connection failed</p>
        <UButton class="mt-3" size="xs" color="neutral" variant="outline" label="Reconnect" @click="reconnect" />
      </div>
    </div>

    <div v-else-if="filteredEvents.length === 0" class="flex flex-1 items-center justify-center px-6 text-center">
      <div>
        <UIcon :name="events.length ? 'i-lucide-search-x' : 'i-lucide-radio'" class="mx-auto size-9 text-zinc-400" />
        <p class="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          {{ events.length ? 'No events match the current filters.' : emptyStateLabel }}
        </p>
      </div>
    </div>

    <div v-else class="flex-1 overflow-y-auto">
      <ol class="divide-y divide-zinc-100 dark:divide-zinc-800/80">
        <li v-for="event in filteredEvents" :key="event.key" class="px-4 py-3">
          <button type="button" class="flex w-full items-start gap-3 text-left" @click="toggleExpanded(event.key)">
            <span class="mt-1 flex size-6 shrink-0 items-center justify-center rounded-md bg-cyan-50 text-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-300">
              <UIcon name="i-lucide-radio-tower" class="size-3.5" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-start justify-between gap-3">
                <span class="min-w-0 truncate font-mono text-xs font-semibold text-zinc-900 dark:text-zinc-100">{{ event.type }}</span>
                <span class="shrink-0 text-[10px] tabular-nums text-zinc-400" :title="event.fullTime">{{ event.time }}</span>
              </span>
              <span class="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                <span v-if="event.nodeUid" class="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{{ event.nodeUid }}</span>
                <span v-if="event.functionId" class="max-w-full truncate rounded bg-blue-50 px-1.5 py-0.5 font-mono text-[10px] text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">{{ event.functionId }}</span>
                <span v-if="!event.nodeUid && !event.functionId" class="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{{ event.preview }}</span>
              </span>
            </span>
            <UIcon :name="isExpanded(event.key) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="mt-0.5 size-4 shrink-0 text-zinc-400" />
          </button>

          <div v-if="isExpanded(event.key)" class="ml-9 mt-3 overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
            <div v-if="event.id" class="border-b border-zinc-200 px-3 py-1.5 font-mono text-[10px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">{{ event.id }}</div>
            <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 text-xs leading-5 text-zinc-700 dark:text-zinc-200">{{ event.payload }}</pre>
          </div>
        </li>
      </ol>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useWorkflowStream, watch } from '#imports'
import type { Ref } from 'vue'

type StreamStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error'

interface StreamInspectorEvent {
  id?: string
  type: string
  data: unknown
  nodeUid?: string
  functionId?: string
  tsUnixMs?: number
}

const props = defineProps<{
  runId: string
  isLive?: boolean
}>()

const filterText = ref('')
const selectedType = ref<string | null>(null)
const expanded = ref<Set<string>>(new Set())
const workflowStream = useWorkflowStream(props.runId) as {
  events: Ref<StreamInspectorEvent[]>
  status: Ref<StreamStatus>
  subscribe: (runId: string) => void
}
const { events, status, subscribe } = workflowStream

const activeFilterClass = 'border-cyan-600 bg-cyan-600 text-white dark:border-cyan-500 dark:bg-cyan-500 dark:text-zinc-950'
const inactiveFilterClass = 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300'

function prettyMessage(value: unknown): string {
  try {
    if (typeof value === 'string') return value
    return JSON.stringify(value, null, 2)
  }
  catch {
    return String(value)
  }
}

function formatTime(timestamp?: number): { short: string, full: string } {
  if (!timestamp) return { short: '--:--:--', full: 'Timestamp unavailable' }
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return { short: '--:--:--', full: String(timestamp) }
  return {
    short: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    full: date.toLocaleString(),
  }
}

const displayEvents = computed(() => events.value.map((event, index) => {
  const payload = prettyMessage(event.data)
  const time = formatTime(event.tsUnixMs)
  return {
    ...event,
    key: event.id || `${event.type}:${event.tsUnixMs || 0}:${event.nodeUid || ''}:${index}`,
    payload,
    preview: payload.replace(/\s+/g, ' ').slice(0, 120),
    time: time.short,
    fullTime: time.full,
  }
}).sort((left, right) => Number(right.tsUnixMs || 0) - Number(left.tsUnixMs || 0)))

const eventTypes = computed(() => [...new Set(displayEvents.value.map(event => event.type))].sort())

const filteredEvents = computed(() => {
  const query = filterText.value.trim().toLowerCase()
  return displayEvents.value.filter((event) => {
    if (selectedType.value && event.type !== selectedType.value) return false
    if (!query) return true
    return [event.type, event.nodeUid, event.functionId, event.payload]
      .some(value => String(value || '').toLowerCase().includes(query))
  })
})

const statusLabel = computed(() => {
  if (status.value === 'connected') return props.isLive ? 'Live' : 'Connected'
  if (status.value === 'connecting') return 'Connecting'
  if (status.value === 'error') return 'Connection failed'
  if (status.value === 'closed') return 'Closed'
  return 'Idle'
})

const statusDotClass = computed(() => ({
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-500 animate-pulse',
  error: 'bg-red-500',
  closed: 'bg-zinc-400',
  idle: 'bg-zinc-400',
}[status.value]))

const emptyStateLabel = computed(() => status.value === 'connecting'
  ? 'Connecting to the run stream...'
  : 'No events have been published for this run.')

function toggleExpanded(key: string) {
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}

function isExpanded(key: string): boolean {
  return expanded.value.has(key)
}

function reconnect() {
  subscribe(props.runId)
}

watch(() => props.runId, (runId) => {
  expanded.value = new Set()
  selectedType.value = null
  filterText.value = ''
  subscribe(runId)
})
</script>