<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Header -->
    <div class="border-b border-gray-200 dark:border-gray-800 px-6 py-3 shrink-0">
      <div class="flex items-center justify-between">
        <h1 class="text-lg font-semibold">
          Workers
        </h1>
        <div class="flex items-center gap-3">
          <div
            v-if="status === 'pending'"
            class="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400"
          >
            <div class="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            <span>Connecting...</span>
          </div>
          <div
            v-else-if="engineOnline"
            class="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400"
          >
            <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Engine online</span>
          </div>
          <div
            v-else
            class="flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400"
          >
            <div class="w-2 h-2 rounded-full bg-red-500" />
            <span>Engine offline</span>
          </div>
          <UButton
            icon="i-lucide-refresh-cw"
            size="xs"
            color="neutral"
            variant="ghost"
            :loading="status === 'pending'"
            @click="refresh"
          />
        </div>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 min-h-0 overflow-y-auto">
      <div class="max-w-5xl mx-auto p-6 space-y-6">
        <!-- Stat cards -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            icon="i-lucide-server"
            :count="namedWorkers.length"
            label="Workers"
            variant="blue"
          />
          <StatCard
            icon="i-lucide-zap"
            :count="totalActiveInvocations"
            label="Active invocations"
            variant="amber"
          />
          <StatCard
            icon="i-lucide-cpu"
            :count="totalFunctions"
            label="Functions"
            variant="purple"
          />
          <StatCard
            icon="i-lucide-shield-check"
            :count="`${healthyComponentCount}/${totalComponentCount}`"
            label="Components healthy"
            variant="emerald"
          />
        </div>

        <!-- Engine health (collapsible) -->
        <div
          v-if="data?.health"
          class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden"
        >
          <button
            type="button"
            class="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
            @click="showHealth = !showHealth"
          >
            <UIcon
              name="i-lucide-heart-pulse"
              class="w-4 h-4 text-emerald-500 shrink-0"
            />
            <h2 class="text-sm font-semibold flex-1">
              Engine Health
            </h2>
            <UBadge
              :color="data.health.status === 'healthy' ? 'success' : 'error'"
              variant="subtle"
              size="xs"
            >
              {{ data.health.status }}
            </UBadge>
            <span class="text-xs text-gray-400 mx-2 font-mono">v{{ data.health.version }}</span>
            <span class="text-xs text-gray-400 mr-1">updated {{ formatRelativeMs(data.health.timestamp) }}</span>
            <UIcon
              :name="showHealth ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              class="w-3.5 h-3.5 text-gray-400 shrink-0"
            />
          </button>
          <div
            v-if="showHealth"
            class="border-t border-gray-100 dark:border-gray-800 px-4 pb-4"
          >
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
              <div
                v-for="(component, name) in data.health.components"
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

        <!-- Workers list -->
        <div>
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-sm font-semibold">
              Registered Workers
              <span class="text-gray-400 font-normal ml-1">({{ namedWorkers.length }})</span>
            </h2>
            <UButton
              v-if="anonymousWorkers.length"
              size="xs"
              variant="ghost"
              color="neutral"
              @click="showAnonymous = !showAnonymous"
            >
              {{ showAnonymous ? 'Hide' : 'Show' }} {{ anonymousWorkers.length }} anonymous
            </UButton>
          </div>

          <!-- Loading skeleton -->
          <div
            v-if="status === 'pending' && !data?.workers?.length"
            class="space-y-2"
          >
            <div
              v-for="n in 3"
              :key="n"
              class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4 animate-pulse"
            >
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700" />
                <div class="flex-1 space-y-1.5">
                  <div class="h-3 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
                  <div class="h-2.5 bg-gray-100 dark:bg-gray-800 rounded w-1/2" />
                </div>
              </div>
            </div>
          </div>

          <!-- Empty state -->
          <div
            v-else-if="!namedWorkers.length && status !== 'pending'"
            class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-8 text-center text-gray-500"
          >
            <UIcon
              name="i-lucide-server-off"
              class="w-10 h-10 mx-auto mb-3 opacity-40"
            />
            <p class="text-sm">
              No workers registered
            </p>
          </div>

          <!-- Worker cards -->
          <div
            v-else
            class="space-y-2"
          >
            <div
              v-for="worker in namedWorkers"
              :key="worker.id"
              class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden"
            >
              <!-- Card header row -->
              <button
                type="button"
                class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                @click="toggleExpand(worker.id)"
              >
                <div
                  class="w-2 h-2 rounded-full shrink-0"
                  :class="statusDot(worker.status)"
                />
                <UIcon
                  :name="runtimeIcon(worker.runtime)"
                  class="w-4 h-4 shrink-0"
                  :class="runtimeIconClass(worker.runtime)"
                />
                <span class="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate flex-1 min-w-0">
                  {{ worker.name }}
                </span>
                <!-- Active invocations pulse -->
                <span
                  v-if="worker.active_invocations > 0"
                  class="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 shrink-0"
                >
                  <div class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                  {{ worker.active_invocations }} active
                </span>
                <span class="text-xs text-gray-400 shrink-0 hidden sm:block">
                  {{ worker.function_count }} fn{{ worker.function_count !== 1 ? 's' : '' }}
                </span>
                <span
                  v-if="worker.version"
                  class="text-xs text-gray-400 font-mono shrink-0 hidden md:block"
                >v{{ worker.version }}</span>
                <span class="text-xs text-gray-400 shrink-0">{{ formatRelativeMs(worker.connected_at_ms) }}</span>
                <UIcon
                  :name="expandedId === worker.id ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                  class="w-3.5 h-3.5 text-gray-400 shrink-0"
                />
              </button>

              <!-- Expanded detail -->
              <div
                v-if="expandedId === worker.id"
                class="border-t border-gray-100 dark:border-gray-800 px-4 pb-4"
              >
                <!-- System info -->
                <div class="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-xs">
                  <span v-if="worker.os">
                    <span class="font-medium text-gray-600 dark:text-gray-300">OS </span>
                    <span class="text-gray-500 dark:text-gray-400">{{ worker.os }}</span>
                  </span>
                  <span v-if="worker.pid != null">
                    <span class="font-medium text-gray-600 dark:text-gray-300">PID </span>
                    <span class="text-gray-500 dark:text-gray-400 font-mono">{{ worker.pid }}</span>
                  </span>
                  <span v-if="worker.ip_address">
                    <span class="font-medium text-gray-600 dark:text-gray-300">IP </span>
                    <span class="text-gray-500 dark:text-gray-400 font-mono">{{ worker.ip_address }}</span>
                  </span>
                  <span class="text-gray-300 dark:text-gray-600 font-mono">{{ worker.id }}</span>
                </div>

                <!-- Resource metrics -->
                <div
                  v-if="worker.latest_metrics"
                  class="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3"
                >
                  <!-- CPU -->
                  <div class="rounded-md bg-gray-50 dark:bg-gray-800/50 p-2.5">
                    <div class="flex items-center justify-between mb-1.5">
                      <span class="text-xs font-medium text-gray-500 dark:text-gray-400">CPU</span>
                      <span class="text-xs font-mono font-semibold text-gray-800 dark:text-gray-200">{{ worker.latest_metrics.cpu_percent.toFixed(1) }}%</span>
                    </div>
                    <div class="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        class="h-full rounded-full transition-all duration-500"
                        :class="worker.latest_metrics.cpu_percent > 80 ? 'bg-red-500' : worker.latest_metrics.cpu_percent > 50 ? 'bg-amber-500' : 'bg-emerald-500'"
                        :style="{ width: `${Math.min(worker.latest_metrics.cpu_percent, 100)}%` }"
                      />
                    </div>
                  </div>
                  <!-- Heap -->
                  <div class="rounded-md bg-gray-50 dark:bg-gray-800/50 p-2.5">
                    <div class="flex items-center justify-between mb-1.5">
                      <span class="text-xs font-medium text-gray-500 dark:text-gray-400">Heap</span>
                      <span class="text-xs font-mono font-semibold text-gray-800 dark:text-gray-200">{{ formatBytes(worker.latest_metrics.memory_heap_used) }} / {{ formatBytes(worker.latest_metrics.memory_heap_total) }}</span>
                    </div>
                    <div class="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        class="h-full bg-blue-500 rounded-full transition-all duration-500"
                        :style="{ width: `${Math.min(worker.latest_metrics.memory_heap_used / worker.latest_metrics.memory_heap_total * 100, 100)}%` }"
                      />
                    </div>
                  </div>
                  <!-- RSS -->
                  <div class="rounded-md bg-gray-50 dark:bg-gray-800/50 p-2.5">
                    <span class="text-xs font-medium text-gray-500 dark:text-gray-400">RSS</span>
                    <p class="text-xs font-mono font-semibold text-gray-800 dark:text-gray-200 mt-0.5">{{ formatBytes(worker.latest_metrics.memory_rss) }}</p>
                  </div>
                  <!-- Event loop lag -->
                  <div class="rounded-md bg-gray-50 dark:bg-gray-800/50 p-2.5">
                    <span class="text-xs font-medium text-gray-500 dark:text-gray-400">Event loop lag</span>
                    <p
                      class="text-xs font-mono font-semibold mt-0.5"
                      :class="worker.latest_metrics.event_loop_lag_ms > 100 ? 'text-red-500' : worker.latest_metrics.event_loop_lag_ms > 20 ? 'text-amber-500' : 'text-gray-800 dark:text-gray-200'"
                    >
                      {{ worker.latest_metrics.event_loop_lag_ms.toFixed(2) }} ms
                    </p>
                  </div>
                </div>

                <!-- Functions list -->
                <div
                  v-if="worker.functions.length"
                  class="mt-4"
                >
                  <p class="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">
                    Functions ({{ worker.functions.length }})
                  </p>
                  <div class="space-y-1">
                    <div
                      v-for="fn in worker.functions"
                      :key="fn"
                      class="flex items-center gap-2 text-xs"
                    >
                      <UBadge
                        v-if="parseFn(fn).trigger"
                        :color="triggerColor(parseFn(fn).trigger)"
                        variant="subtle"
                        size="xs"
                        class="shrink-0 font-mono"
                      >
                        {{ parseFn(fn).trigger }}
                      </UBadge>
                      <span
                        v-else
                        class="w-[42px] shrink-0"
                      />
                      <span class="text-gray-600 dark:text-gray-300 font-mono truncate flex-1">{{ parseFn(fn).path }}</span>
                      <span
                        v-if="parseFn(fn).config"
                        class="text-gray-400 dark:text-gray-500 font-mono shrink-0 truncate max-w-[220px]"
                      >{{ parseFn(fn).config }}</span>
                    </div>
                  </div>
                </div>
                <p
                  v-else
                  class="mt-3 text-xs text-gray-400"
                >
                  No functions registered
                </p>
              </div>
            </div>

            <!-- Anonymous connections -->
            <template v-if="showAnonymous && anonymousWorkers.length">
              <div class="flex items-center gap-2 mt-4 mb-1">
                <div class="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                <span class="text-xs text-gray-400 shrink-0">{{ anonymousWorkers.length }} anonymous connection(s)</span>
                <div class="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
              </div>
              <div
                v-for="worker in anonymousWorkers"
                :key="worker.id"
                class="bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-dashed border-gray-200 dark:border-gray-800 px-4 py-2.5 flex items-center gap-3 opacity-60"
              >
                <div
                  class="w-2 h-2 rounded-full shrink-0"
                  :class="statusDot(worker.status)"
                />
                <span class="text-xs text-gray-500 dark:text-gray-400 font-mono flex-1 truncate">{{ worker.id }}</span>
                <span class="text-xs text-gray-400">{{ formatRelativeMs(worker.connected_at_ms) }}</span>
              </div>
            </template>
          </div>
        </div>

        <!-- Error notice -->
        <UAlert
          v-if="data?.healthError || data?.workersError"
          icon="i-lucide-triangle-alert"
          color="error"
          variant="subtle"
          title="Engine unreachable"
          :description="data?.healthError || data?.workersError || undefined"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from '#imports'
import { useWorkers } from '../composables/useWorkers'

const { data, refresh, status, engineOnline } = useWorkers(5000)

const showHealth = ref(true)
const showAnonymous = ref(false)
const expandedId = ref<string | null>(null)

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

// ─── Worker segmentation ────────────────────────────────────────────────────

const namedWorkers = computed(() =>
  (data.value?.workers ?? []).filter(w => w.name !== null),
)

const anonymousWorkers = computed(() =>
  (data.value?.workers ?? []).filter(w => w.name === null),
)

// ─── Stat values ────────────────────────────────────────────────────────────

const totalActiveInvocations = computed(() =>
  (data.value?.workers ?? []).reduce((s, w) => s + (w.active_invocations ?? 0), 0),
)

const totalFunctions = computed(() =>
  namedWorkers.value.reduce((s, w) => s + (w.function_count ?? 0), 0),
)

const totalComponentCount = computed(() =>
  Object.keys(data.value?.health?.components ?? {}).length,
)

const healthyComponentCount = computed(() =>
  Object.values(data.value?.health?.components ?? {}).filter(c => c.status === 'healthy').length,
)

// ─── Helpers ────────────────────────────────────────────────────────────────

function statusDot(status: string | undefined | null): string {
  if (status === 'connected' || status === 'idle') return 'bg-emerald-500'
  if (status === 'disconnected') return 'bg-red-500'
  return 'bg-gray-400'
}

function runtimeIcon(runtime: string | null | undefined): string {
  if (runtime === 'node') return 'i-devicon-nodejs'
  if (runtime === 'python') return 'i-devicon-python'
  return 'i-lucide-cpu'
}

function runtimeIconClass(runtime: string | null | undefined): string {
  if (runtime === 'node') return 'text-green-500'
  if (runtime === 'python') return 'text-blue-400'
  return 'text-gray-400'
}

interface ParsedFn {
  path: string
  trigger: string | null
  config: string | null
}

function parseFn(id: string): ParsedFn {
  const m = id.match(/^(.+?)::trigger::(\w+)\((.+)\)$/)
  if (m) return { path: m[1]!, trigger: m[2]!, config: m[3]! }
  return { path: id, trigger: null, config: null }
}

function triggerColor(trigger: string | null): 'info' | 'success' | 'warning' | 'neutral' {
  if (trigger === 'http') return 'info'
  if (trigger === 'queue') return 'success'
  if (trigger === 'cron') return 'warning'
  return 'neutral'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatRelativeMs(ms: number | string): string {
  const ts = typeof ms === 'number' ? ms : new Date(ms).getTime()
  const diff = Math.round((Date.now() - ts) / 1000)
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}
</script>
