<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- Compact Gray Header -->
    <div class="h-[72px] px-6 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 shrink-0 flex items-center justify-between">
      <div class="flex items-center gap-2 min-w-0">
        <UIcon
          name="i-lucide-activity"
          class="w-3.5 h-3.5 text-gray-500"
        />
        <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Audit Log
        </span>
        <span
          v-if="isLive"
          class="flex items-center gap-1 ml-2"
        >
          <div class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span class="text-xs text-gray-500 dark:text-gray-400">Live</span>
        </span>
      </div>
      <span class="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
        {{ currentCount }} {{ currentCount === 1 ? currentLabelSingular : currentLabelPlural }}
      </span>
    </div>

    <!-- Filter Bar (white background, not gray) -->
    <div class="px-4 py-2.5 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-zinc-900 shrink-0 flex items-center justify-between gap-3">
      <div class="flex items-center gap-2 text-xs">
        <UIcon
          name="i-lucide-sliders-horizontal"
          class="w-3.5 h-3.5 text-gray-400"
        />
        <URadioGroup
          v-model="mode"
          :items="modeOptions"
          orientation="horizontal"
          size="xs"
          variant="table"
          indicator="hidden"
          :ui="{
            base: 'text-[9px]',
            container: 'gap-1',
            item: 'px-2 py-0.5 rounded border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 transition-colors',
          }"
        />
      </div>
      <div class="flex items-center gap-2">
        <div class="flex items-center gap-1 text-xs">
          <span class="text-gray-500 dark:text-gray-400">traces:</span>
          <span class="font-medium text-gray-900 dark:text-gray-100">{{ eventCount }}</span>
        </div>
        <div class="w-px h-3 bg-gray-200 dark:bg-gray-700" />
        <div class="flex items-center gap-1 text-xs">
          <span class="text-gray-500 dark:text-gray-400">logs:</span>
          <span class="font-medium text-gray-900 dark:text-gray-100">{{ logCount }}</span>
        </div>
        <div class="w-px h-3 bg-gray-200 dark:bg-gray-700" />
        <div class="flex items-center gap-1 text-xs">
          <span class="text-gray-500 dark:text-gray-400">state:</span>
          <span class="font-medium text-gray-900 dark:text-gray-100">{{ stateEventCount }}</span>
        </div>
        <div class="w-px h-3 bg-gray-200 dark:bg-gray-700" />
        <div class="flex items-center gap-1 text-xs">
          <span class="text-gray-500 dark:text-gray-400">streams:</span>
          <span class="font-medium text-gray-900 dark:text-gray-100">{{ streamCount }}</span>
        </div>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto overflow-x-hidden">
      <template v-if="mode === 'streams'">
        <div
          v-if="streamItems.length === 0"
          class="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500"
        >
          <UIcon
            name="i-lucide-inbox"
            class="w-12 h-12 mb-3 opacity-50"
          />
          <span class="text-sm">No streams yet.</span>
        </div>

        <div
          v-else
          class="min-h-full"
        >
          <TimelineList
            :items="streamItems"
            height-class="min-h-full"
          />
        </div>
      </template>

      <template v-else>
        <div
          v-if="modeItems.length === 0"
          class="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500"
        >
          <UIcon
            name="i-lucide-inbox"
            class="w-12 h-12 mb-3 opacity-50"
          />
          <span class="text-sm">No {{ mode }} yet.</span>
        </div>
        <TimelineList
          v-else
          :items="modeItems"
          height-class="min-h-full"
        />
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from '#imports'
import TimelineList from '../TimelineList.vue'

const props = defineProps<{
  events: any[]
  logs: any[]
  states: any[]
  streams: any[]
  selectedStep?: string | null
  isLive?: boolean
}>()

defineEmits<{
  export: []
}>()

const mode = ref<'traces' | 'logs' | 'state-events' | 'streams'>('traces')

const modeOptions = [
  { value: 'traces', label: 'Traces' },
  { value: 'logs', label: 'Logs' },
  { value: 'state-events', label: 'States' },
  { value: 'streams', label: 'Streams' },
]

const eventCount = computed(() => props.events.length)
const logCount = computed(() => props.logs.length)
const stateCount = computed(() => props.states.length)
const streamCount = computed(() => props.streams.length)
const currentCount = computed(() => {
  if (mode.value === 'logs') return logCount.value
  if (mode.value === 'state-events') return stateEventCount.value
  if (mode.value === 'streams') return streamCount.value
  return eventCount.value
})
const currentLabelSingular = computed(() => {
  if (mode.value === 'logs') return 'log'
  if (mode.value === 'state-events') return 'event'
  if (mode.value === 'streams') return 'stream'
  return 'event'
})
const currentLabelPlural = computed(() => {
  if (mode.value === 'logs') return 'logs'
  if (mode.value === 'state-events') return 'events'
  if (mode.value === 'streams') return 'streams'
  return 'events'
})

// Filter state events from logs (workflow.state.set, workflow.state.delete events)
const stateEvents = computed(() => {
  return props.events.filter((event: any) =>
    event?.event_name === 'workflow.state.set'
    || event?.event_name === 'workflow.state.delete'
    || event?.type === 'state.set'
    || event?.type === 'state.delete',
  )
})
const stateEventCount = computed(() => stateEvents.value.length)

function toTimelineLog(log: any) {
  return {
    id: `log-${log.ts}-${log.stepName || ''}`,
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
  }
}

const modeItems = computed(() => {
  const selected =
    mode.value === 'traces' ? props.events
      : mode.value === 'logs' ? props.logs.map(toTimelineLog)
        : mode.value === 'state-events' ? stateEvents.value
          : []

  const items = Array.isArray(selected) ? [...selected] : []
  items.sort((a: any, b: any) => {
    const aTs = typeof a?.ts_unix_ms === 'number' ? a.ts_unix_ms : (typeof a?.ts === 'number' ? a.ts : Number(a?.ts || 0))
    const bTs = typeof b?.ts_unix_ms === 'number' ? b.ts_unix_ms : (typeof b?.ts === 'number' ? b.ts : Number(b?.ts || 0))
    return bTs - aTs
  })
  return items
})

const streamItems = computed(() => {
  return props.streams.map((stream: any, index: number) => {
    const data = stream && typeof stream === 'object' ? stream : { streamName: String(stream || '') }
    const streamName = String(data.streamName || data.name || data.key || data.id || '')
    const preview = data.preview || data.payloadSummary || data.summary || data.data || data.value || ''
    return {
      id: data.id || `stream-${streamName || index}`,
      ts: Number(data.ts || data.ts_unix_ms || Date.now() - index),
      type: String(data.type || data.eventName || 'stream.publish'),
      data: {
        streamName,
        runId: String(data.runId || data.groupId || data.group_id || ''),
        itemId: data.itemId || data.item_id || undefined,
        nodeUid: data.nodeUid || data.node_uid || undefined,
        functionId: data.functionId || data.function_id || undefined,
        preview: typeof preview === 'string' ? preview : JSON.stringify(preview),
      },
    }
  }).sort((a, b) => b.ts - a.ts)
})

function formatTimestamp(ts: number) {
  if (!ts) return 'unknown'
  return new Date(ts).toLocaleTimeString()
}

const latestTimestampLabel = computed(() => {
  const first = modeItems.value[0]
  if (!first) return 'No activity yet'

  const ts = typeof first.ts === 'number' ? first.ts : new Date(first.ts).getTime()
  if (!Number.isFinite(ts)) return 'No activity yet'

  return `Latest update ${new Date(ts).toLocaleTimeString()}`
})
</script>
