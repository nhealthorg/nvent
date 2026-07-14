<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Header -->
    <div class="border-b border-gray-200 dark:border-gray-800 px-6 py-3 shrink-0">
      <div class="flex items-center justify-between">
        <h1 class="text-lg font-semibold">
          Workers
        </h1>
        <div class="flex items-center gap-3">
          <ClientOnly>
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

            <template #fallback>
              <div class="flex items-center gap-1.5 text-xs text-gray-400">
                <div class="w-2 h-2 rounded-full bg-gray-300 animate-pulse" />
                <span>Checking...</span>
              </div>
            </template>
          </ClientOnly>

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
          <NventStatCard
            icon="i-lucide-server"
            :count="namedWorkers.length"
            label="Workers"
            variant="blue"
          />
          <NventStatCard
            icon="i-lucide-zap"
            :count="totalActiveInvocations"
            label="Active invocations"
            variant="amber"
          />
          <NventStatCard
            icon="i-lucide-cpu"
            :count="totalFunctions"
            label="Functions"
            variant="purple"
          />
          <NventStatCard
            icon="i-lucide-shield-check"
            :count="`${healthyComponentCount}/${totalComponentCount}`"
            label="Components healthy"
            variant="emerald"
          />
        </div>

        <!-- Engine health (collapsible) -->
        <NventWorkerEngineHealth :health="data?.health ?? null" />

        <!-- Workers list -->
        <div>
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <h2 class="text-sm font-semibold">
                Registered Workers
                <span class="text-gray-400 font-normal ml-1">({{ filteredWorkers.length }}<template v-if="filterProjectOnly">/{{ namedWorkers.length }}</template>)</span>
              </h2>
              <UButton
                :icon="filterProjectOnly ? 'i-lucide-filter' : 'i-lucide-list'"
                :color="filterProjectOnly ? 'primary' : 'neutral'"
                variant="ghost"
                size="xs"
                class="-ml-1"
                @click="filterProjectOnly = !filterProjectOnly"
              >
                {{ filterProjectOnly ? 'Project only' : 'All workers' }}
              </UButton>
            </div>
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
            v-else-if="!filteredWorkers.length && status !== 'pending'"
            class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-8 text-center text-gray-500"
          >
            <UIcon
              name="i-lucide-server-off"
              class="w-10 h-10 mx-auto mb-3 opacity-40"
            />
            <p class="text-sm">
              {{ filterProjectOnly ? 'No project workers found' : 'No workers registered' }}
            </p>
            <UButton
              v-if="filterProjectOnly && namedWorkers.length"
              variant="link"
              color="primary"
              class="mt-2"
              @click="filterProjectOnly = false"
            >
              Show all workers
            </UButton>
          </div>

          <!-- Worker cards -->
          <div
            v-else
            class="space-y-2"
          >
            <NventWorkerCard
              v-for="worker in filteredWorkers"
              :key="worker.id"
              :worker="worker"
              :is-expanded="expandedId === worker.id"
              @toggle="toggleExpand(worker.id)"
            />

            <!-- Anonymous connections -->
            <NventWorkerAnonymousList
              v-if="showAnonymous"
              :workers="anonymousWorkers"
            />
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
import { computed, ref, useWorkers } from '#imports'

const { data, refresh, status, engineOnline } = useWorkers(5000)

const showHealth = ref(true)
const showAnonymous = ref(false)
const filterProjectOnly = ref(true)
const expandedId = ref<string | null>(null)

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

// ─── Worker segmentation ────────────────────────────────────────────────────

const namedWorkers = computed(() =>
  (data.value?.workers ?? []).filter(w => w.name !== null),
)

const filteredWorkers = computed(() => {
  const list = namedWorkers.value
  if (!filterProjectOnly.value) return list
  return list.filter(w => w.name?.toLowerCase().includes('nvent'))
})

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

function formatRelativeMs(ms: number | string): string {
  const ts = typeof ms === 'number' ? ms : new Date(ms).getTime()
  const diff = Math.round((Date.now() - ts) / 1000)
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}
</script>
