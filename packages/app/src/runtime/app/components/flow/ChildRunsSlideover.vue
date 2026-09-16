<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- Header -->
    <div class="px-6 py-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 shrink-0 space-y-3">
      <div class="flex items-center gap-2">
        <UIcon
          name="i-lucide-git-branch"
          class="w-4 h-4 text-gray-400"
        />
        <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Child Runs
        </span>
        <span class="text-xs text-gray-500 dark:text-gray-400">({{ runs.length }})</span>
      </div>

      <!-- Status summary -->
      <div class="flex flex-wrap items-center gap-1.5">
        <UBadge
          v-for="entry in statusSummary"
          :key="entry.status"
          size="xs"
          :color="entry.color"
          variant="soft"
          class="cursor-pointer"
          :class="statusFilter === entry.status ? 'ring-1 ring-primary-500' : ''"
          @click="statusFilter = statusFilter === entry.status ? null : entry.status"
        >
          {{ entry.label }}: {{ entry.count }}
        </UBadge>
      </div>

      <!-- Search -->
      <div class="flex items-center gap-2">
        <div class="flex-1 relative">
          <UIcon
            name="i-lucide-search"
            class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
          />
          <input
            v-model="filterText"
            type="text"
            placeholder="Filter by index or run id..."
            class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400"
          />
        </div>
      </div>
    </div>

    <!-- List -->
    <div class="flex-1 overflow-y-auto">
      <div
        v-if="filteredRuns.length === 0"
        class="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500"
      >
        <UIcon
          name="i-lucide-inbox"
          class="w-12 h-12 mb-3 opacity-50"
        />
        <span class="text-sm">No matching child runs</span>
      </div>

      <div
        v-else
        class="divide-y divide-gray-100 dark:divide-gray-800"
      >
        <button
          v-for="run in pagedRuns"
          :key="run.runId"
          type="button"
          class="w-full text-left px-6 py-3 flex items-center justify-between gap-3 hover:bg-gray-50 dark:hover:bg-gray-900/50"
          @click="emit('open-child-run', run.runId)"
        >
          <div class="min-w-0 flex items-center gap-2">
            <UIcon
              :name="statusIcon(run.status)"
              class="w-4 h-4 flex-shrink-0"
              :class="statusIconColor(run.status)"
            />
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-xs font-semibold text-gray-900 dark:text-gray-100">#{{ run.index }}</span>
                <span class="text-xs font-mono text-gray-500 dark:text-gray-400 truncate">{{ run.runId }}</span>
              </div>
              <p
                v-if="run.error"
                class="text-[11px] text-red-500 dark:text-red-400 truncate mt-0.5"
                :title="run.error"
              >
                {{ run.error }}
              </p>
            </div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <span
              v-if="formatDuration(run)"
              class="text-[10px] text-gray-400"
            >{{ formatDuration(run) }}</span>
            <UBadge
              size="xs"
              :color="statusColor(run.status)"
              variant="subtle"
              class="capitalize"
            >
              {{ run.status || 'pending' }}
            </UBadge>
            <UIcon
              name="i-lucide-external-link"
              class="w-3.5 h-3.5 text-gray-400"
            />
          </div>
        </button>
      </div>
    </div>

    <!-- Pagination -->
    <div
      v-if="filteredRuns.length > pageSize"
      class="px-6 py-3 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400"
    >
      <span>Page {{ page + 1 }} / {{ totalPages }}</span>
      <div class="flex items-center gap-2">
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-chevron-left"
          :disabled="page === 0"
          @click="page--"
        >
          Prev
        </UButton>
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          trailing-icon="i-lucide-chevron-right"
          :disabled="page >= totalPages - 1"
          @click="page++"
        >
          Next
        </UButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from '#imports'

export interface ChildRunEntry {
  index: number
  runId: string
  status: string
  error?: string
  retries?: number
  pendingAt?: number
  completedAt?: number
}

const props = defineProps<{
  runs: ChildRunEntry[]
}>()

const emit = defineEmits<{
  'open-child-run': [runId: string]
}>()

const pageSize = 50
const page = ref(0)
const filterText = ref('')
const statusFilter = ref<string | null>(null)

function normalizedStatus(status: string): 'running' | 'completed' | 'failed' | 'other' {
  const s = (status || '').toLowerCase()
  if (s === 'running' || s === 'active' || s === 'queued' || s === 'pending') return 'running'
  if (s === 'done' || s === 'completed') return 'completed'
  if (s === 'failed' || s === 'error') return 'failed'
  return 'other'
}

const statusSummary = computed(() => {
  const counts = { running: 0, completed: 0, failed: 0, other: 0 }
  for (const run of props.runs) counts[normalizedStatus(run.status)]++
  return [
    { status: 'completed', label: 'Done', count: counts.completed, color: 'success' as const },
    { status: 'running', label: 'Running', count: counts.running, color: 'warning' as const },
    { status: 'failed', label: 'Failed', count: counts.failed, color: 'error' as const },
    { status: 'other', label: 'Pending', count: counts.other, color: 'neutral' as const },
  ].filter(entry => entry.count > 0)
})

const filteredRuns = computed(() => {
  const text = filterText.value.trim().toLowerCase()
  return props.runs.filter((run) => {
    if (statusFilter.value && normalizedStatus(run.status) !== statusFilter.value) return false
    if (!text) return true
    return String(run.index).includes(text) || run.runId.toLowerCase().includes(text)
  })
})

const totalPages = computed(() => Math.max(1, Math.ceil(filteredRuns.value.length / pageSize)))

const pagedRuns = computed(() => {
  const start = page.value * pageSize
  return filteredRuns.value.slice(start, start + pageSize)
})

watch([filterText, statusFilter], () => {
  page.value = 0
})

function statusIcon(status: string): string {
  switch (normalizedStatus(status)) {
    case 'running': return 'i-heroicons-arrow-path-20-solid'
    case 'completed': return 'i-heroicons-check-circle-20-solid'
    case 'failed': return 'i-heroicons-x-circle-20-solid'
    default: return 'i-heroicons-clock-20-solid'
  }
}

function statusIconColor(status: string): string {
  switch (normalizedStatus(status)) {
    case 'running': return 'text-amber-500'
    case 'completed': return 'text-emerald-500'
    case 'failed': return 'text-red-500'
    default: return 'text-gray-400'
  }
}

function statusColor(status: string): 'warning' | 'success' | 'error' | 'neutral' {
  switch (normalizedStatus(status)) {
    case 'running': return 'warning'
    case 'completed': return 'success'
    case 'failed': return 'error'
    default: return 'neutral'
  }
}

function formatDuration(run: ChildRunEntry): string | null {
  if (!run.pendingAt) return null
  const end = run.completedAt || Date.now()
  const ms = end - run.pendingAt
  if (ms < 0) return null
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
</script>
