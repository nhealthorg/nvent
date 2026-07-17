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
        {{ modeItems.length }} {{ modeItems.length === 1 ? 'event' : 'events' }}
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
      </div>
    </div>

    <div class="flex-1 overflow-y-auto overflow-x-hidden">
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

const mode = ref<'traces' | 'logs' | 'state-events'>('traces')

const modeOptions = [
  { value: 'traces', label: 'Traces' },
  { value: 'logs', label: 'Logs' },
  { value: 'state-events', label: 'State Events' },
]

const eventCount = computed(() => props.events.length)
const logCount = computed(() => props.logs.length)
const stateCount = computed(() => props.states.length)
const streamCount = computed(() => props.streams.length)

// Filter state events from logs (workflow.state.set, workflow.state.delete events)
const stateEvents = computed(() => {
  return props.events.filter(e => 
    e?.event_name === 'workflow.state.set' || 
    e?.event_name === 'workflow.state.delete'
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

const filteredItems = modeItems

const latestTimestampLabel = computed(() => {
  const first = modeItems.value[0]
  if (!first) return 'No activity yet'

  const ts = typeof first.ts === 'number' ? first.ts : new Date(first.ts).getTime()
  if (!Number.isFinite(ts)) return 'No activity yet'

  return `Latest update ${new Date(ts).toLocaleTimeString()}`
})
</script>
