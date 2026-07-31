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
        <select
          v-if="showLoopFilter"
          class="text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-zinc-900 px-2 py-1"
          :value="selectedLoopIndex !== null ? String(selectedLoopIndex) : ''"
          @change="onLoopIndexChange"
        >
          <option
            v-for="option in (loopIndexOptions || [])"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
        <button
          v-if="hasMoreTimeline"
          class="ml-2 text-xs rounded border border-gray-200 dark:border-gray-700 px-2 py-1 hover:border-blue-400 dark:hover:border-blue-600 disabled:opacity-50"
          :disabled="Boolean(timelineLoadingMore) || Boolean(timelinePending)"
          @click="loadMore"
        >
          {{ timelineLoadingMore ? 'Loading...' : 'Load more' }}
        </button>
      </div>
    </div>

    <UScrollArea
      ref="scrollArea"
      class="flex-1"
      :ui="{ viewport: 'flex flex-col min-h-full' }"
      shadow
    >
      <div
        v-if="timelineError"
        class="px-4 py-3 text-xs text-red-600 dark:text-red-400 border-b border-red-200 dark:border-red-900"
      >
        Timeline loading failed.
      </div>

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

      <div
        v-if="(timelinePending && !backgroundRefreshing) || timelineLoadingMore"
        class="px-4 py-2 text-xs text-gray-500 dark:text-gray-400"
      >
        Loading {{ mode }}...
      </div>
    </UScrollArea>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, useFetch } from '#imports'
import { useInfiniteScroll } from '@vueuse/core'
import TimelineList from '../TimelineList.vue'

type TimelineMode = 'traces' | 'logs' | 'states' | 'streams' | 'vars'

interface TimelineItem {
  id: string
  ts: number
  type: string
  stepName?: string
  level?: string
  message?: string
  data?: Record<string, unknown>
}

interface TracesResponse {
  type: TimelineMode
  items: TimelineItem[]
  has_more: boolean
  next_offset: number
}

const props = defineProps<{
  runId: string
  runStatus: string
  startedAt?: number
  completedAt?: number
  nodeCheckpoints?: Record<string, unknown>
  selectedStep?: string | null
  selectedStepNodeIds?: string[]
  loopIndexOptions?: Array<{ value: string, label: string }>
}>()

const mode = ref<TimelineMode>('traces')
const pageSize = 20
const offset = ref(0)
const items = ref<TimelineItem[]>([])
const hasMoreTimeline = ref(false)
const timelineLoadingMore = ref(false)
const selectedLoopIndex = ref<number | null>(null)
const scrollArea = ref<{ $el?: HTMLElement } | null>(null)
const backgroundRefreshing = ref(false)
let inFlight: Promise<void> | null = null

const selectedNodeUids = computed(() => {
  const value = props.selectedStep
  if (!value) return undefined
  if (value.startsWith('loop-group:')) {
    return props.selectedStepNodeIds?.length ? props.selectedStepNodeIds : undefined
  }

  const base = value.split('#')[0]
  return base ? [base] : undefined
})

const tracesQuery = computed(() => ({
  run_id: props.runId,
  type: mode.value,
  limit: pageSize,
  offset: offset.value,
  node_uids: selectedNodeUids.value,
  loop_index: selectedLoopIndex.value ?? undefined,
}))

const {
  data: tracesData,
  pending: timelinePending,
  error: timelineError,
  execute: executeFetch,
} = useFetch<TracesResponse>('/api/_workflows/traces', {
  query: tracesQuery,
  immediate: false,
  server: false,
  watch: false,
})

async function fetchCurrentMode(append = false, options?: { silent?: boolean }) {
  if (!props.runId) return
  if (inFlight && !append) return inFlight

  const silent = Boolean(options?.silent)

  const run = async () => {
  if (append) {
    if (timelinePending.value || timelineLoadingMore.value || !hasMoreTimeline.value) return
    timelineLoadingMore.value = true
  }
  else {
    offset.value = 0
    hasMoreTimeline.value = false
  }

  backgroundRefreshing.value = silent
  await executeFetch()

  const response = tracesData.value
  const nextItems = Array.isArray(response?.items) ? response.items : []

  items.value = append ? [...items.value, ...nextItems] : nextItems
  hasMoreTimeline.value = Boolean(response?.has_more)
  offset.value = Number(response?.next_offset || 0)
  timelineLoadingMore.value = false
  backgroundRefreshing.value = false
  }

  inFlight = run().finally(() => {
    backgroundRefreshing.value = false
    inFlight = null
  })

  return inFlight
}

async function loadMore() {
  await fetchCurrentMode(true)
}

const isLive = computed(() => {
  return props.runStatus === 'running' || props.runStatus === 'awaiting_nodes' || props.runStatus === 'awaiting'
})

function baseStepName(stepName?: string | null): string | null {
  if (!stepName) return null
  return String(stepName).split('#')[0] || null
}

function stepMatchesSelection(stepName: string | null | undefined, selection: string | null | undefined): boolean {
  if (!selection) return true
  const base = baseStepName(stepName)
  if (!base) return false

  if (selection.startsWith('loop-group:')) {
    const members = props.selectedStepNodeIds || []
    return members.includes(base)
  }

  return base === selection
}

const filteredEvents = computed(() => {
  if (!props.selectedStep) return items.value
  return items.value.filter((item: TimelineItem) => {
    if (!item.stepName) {
      return item.type === 'flow.start' || item.type === 'flow.completed' || item.type === 'flow.failed'
    }
    return stepMatchesSelection(item.stepName, props.selectedStep)
  })
})

const filteredLogs = computed(() => {
  if (!props.selectedStep) return items.value
  return items.value.filter((item: TimelineItem) => stepMatchesSelection(item.stepName, props.selectedStep))
})

let refreshInterval: any = null
onMounted(() => {
  useInfiniteScroll(
    () => scrollArea.value?.$el,
    () => loadMore(),
    {
      distance: 200,
      canLoadMore: () => hasMoreTimeline.value && !timelinePending.value && !timelineLoadingMore.value,
    },
  )

  refreshInterval = setInterval(() => {
    if (isLive.value) {
      void fetchCurrentMode(false, { silent: true })
    }
  }, 3000)
})

onUnmounted(() => {
  if (refreshInterval) clearInterval(refreshInterval)
})

watch(() => props.runId, () => {
  selectedLoopIndex.value = null
  void fetchCurrentMode(false)
}, { immediate: true })

watch(mode, () => {
  void fetchCurrentMode(false)
})

watch(selectedLoopIndex, () => {
  void fetchCurrentMode(false)
})

watch(() => props.selectedStep, () => {
  void fetchCurrentMode(false)
})

watch(() => props.loopIndexOptions, (options) => {
  const visible = Array.isArray(options) && options.length > 1
  if (!visible && selectedLoopIndex.value !== null) {
    selectedLoopIndex.value = null
  }
})

function onLoopIndexChange(event: Event) {
  const target = event.target as HTMLSelectElement | null
  selectedLoopIndex.value = target?.value === '' ? null : Number(target?.value)
}

const modeOptions = [
  { value: 'traces', label: 'Traces' },
  { value: 'logs', label: 'Logs' },
  { value: 'states', label: 'States' },
  { value: 'vars', label: 'Vars' },
  { value: 'streams', label: 'Streams' },
]

const eventCount = computed(() => mode.value === 'traces' ? filteredEvents.value.length : 0)
const logCount = computed(() => mode.value === 'logs' ? filteredLogs.value.length : 0)
const stateCount = computed(() => mode.value === 'states' ? modeItems.value.length : 0)
const varCount = computed(() => mode.value === 'vars' ? modeItems.value.length : 0)
const streamCount = computed(() => mode.value === 'streams' ? streamItems.value.length : 0)

const currentCount = computed(() => {
  if (mode.value === 'logs') return logCount.value
  if (mode.value === 'states') return stateCount.value
  if (mode.value === 'vars') return varCount.value
  if (mode.value === 'streams') return streamCount.value
  return eventCount.value
})
const currentLabelSingular = computed(() => {
  if (mode.value === 'logs') return 'log'
  if (mode.value === 'states') return 'state'
  if (mode.value === 'vars') return 'var'
  if (mode.value === 'streams') return 'stream'
  return 'trace'
})
const currentLabelPlural = computed(() => {
  if (mode.value === 'logs') return 'logs'
  if (mode.value === 'states') return 'states'
  if (mode.value === 'vars') return 'vars'
  if (mode.value === 'streams') return 'streams'
  return 'traces'
})

const modeItems = computed(() => {
  const selected = mode.value === 'traces'
    ? filteredEvents.value
    : mode.value === 'logs'
      ? filteredLogs.value
      : mode.value === 'states'
        ? items.value
      : mode.value === 'vars'
        ? (props.selectedStep ? items.value.filter((item: TimelineItem) => stepMatchesSelection(item.stepName, props.selectedStep)) : items.value)
        : []

  const output = Array.isArray(selected) ? [...selected] : []
  output.sort((a: TimelineItem, b: TimelineItem) => {
    const aTs = Number(a?.ts || 0)
    const bTs = Number(b?.ts || 0)
    return bTs - aTs
  })
  return output
})

const streamItems = computed(() => {
  const list = items.value
    .filter(item => item.type === 'stream.publish' || item.type === 'stream.delete')
    .filter(item => !props.selectedStep || stepMatchesSelection(item.stepName, props.selectedStep))

  return [...list].sort((a, b) => b.ts - a.ts)
})

const showLoopFilter = computed(() => {
  return Array.isArray(props.loopIndexOptions) && props.loopIndexOptions.length > 1
})
</script>
