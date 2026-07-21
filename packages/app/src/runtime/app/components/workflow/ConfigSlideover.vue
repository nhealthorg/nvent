<template>
  <USlideover
    v-model:open="isOpen"
    title="Workflow Worker Config"
    description="Current effective runtime configuration"
  >
    <template #content>
      <div class="p-6 h-full flex flex-col bg-white dark:bg-zinc-950">
        <div class="flex items-center justify-between mb-6">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400">
              <UIcon name="i-lucide-sliders-horizontal" class="w-5 h-5" />
            </div>
            <div>
              <h3 class="text-base font-semibold text-zinc-900 dark:text-white">Effective Worker Configuration</h3>
              <p class="text-xs text-zinc-500 dark:text-zinc-400">Loaded from configuration worker plus startup overrides</p>
            </div>
          </div>
          <UButton
            icon="i-lucide-refresh-cw"
            variant="ghost"
            color="neutral"
            :loading="loading"
            @click="loadConfig"
          />
        </div>

        <div class="flex-1 overflow-y-auto space-y-4">
          <div v-if="error" class="p-4 rounded-xl border border-red-200 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-300 text-sm">
            {{ error }}
          </div>

          <div v-else-if="loading" class="py-12 flex items-center justify-center text-zinc-500 text-sm">
            Loading workflow config...
          </div>

          <template v-else>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 bg-zinc-50/70 dark:bg-zinc-900/30">
                <p class="text-[11px] uppercase tracking-wider text-zinc-500">Default Pending Timeout</p>
                <p class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ formatMs(config?.default_pending_timeout_ms) }}</p>
              </div>
              <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 bg-zinc-50/70 dark:bg-zinc-900/30">
                <p class="text-[11px] uppercase tracking-wider text-zinc-500">Sweep Expression</p>
                <p class="text-sm font-semibold text-zinc-900 dark:text-zinc-100 font-mono">{{ config?.sweep_expression || 'n/a' }}</p>
              </div>
              <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 bg-zinc-50/70 dark:bg-zinc-900/30">
                <p class="text-[11px] uppercase tracking-wider text-zinc-500">Dispatch Timeout</p>
                <p class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ formatMs(config?.dispatch_timeout_ms) }}</p>
              </div>
              <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 bg-zinc-50/70 dark:bg-zinc-900/30">
                <p class="text-[11px] uppercase tracking-wider text-zinc-500">Max Node Retries</p>
                <p class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ config?.max_node_retries ?? 'n/a' }}</p>
              </div>
              <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 bg-zinc-50/70 dark:bg-zinc-900/30">
                <p class="text-[11px] uppercase tracking-wider text-zinc-500">Run Retention</p>
                <p class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ formatDays(config?.run_retention_ms) }}</p>
              </div>
              <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 bg-zinc-50/70 dark:bg-zinc-900/30">
                <p class="text-[11px] uppercase tracking-wider text-zinc-500">Log/Trace Retention</p>
                <p class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{{ formatDays(config?.observability_retention_ms) }}</p>
              </div>
            </div>

            <div class="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              <div class="px-4 py-2 bg-zinc-100/70 dark:bg-zinc-900/60 border-b border-zinc-200 dark:border-zinc-800 text-xs font-semibold text-zinc-600 dark:text-zinc-300 uppercase tracking-wider">
                Raw JSON
              </div>
              <pre class="p-4 text-xs font-mono text-zinc-700 dark:text-zinc-200 overflow-x-auto">{{ prettyConfig }}</pre>
            </div>
          </template>
        </div>
      </div>
    </template>
  </USlideover>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

interface WorkflowWorkerConfig {
  default_pending_timeout_ms: number
  sweep_expression: string
  dispatch_timeout_ms: number
  max_node_retries: number
  run_retention_ms: number
  observability_retention_ms: number
}

interface ConfigResponse {
  config: WorkflowWorkerConfig
}

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits(['update:modelValue'])

const isOpen = computed({
  get: () => props.modelValue,
  set: (val: boolean) => emit('update:modelValue', val),
})

const loading = ref(false)
const error = ref<string | null>(null)
const config = ref<WorkflowWorkerConfig | null>(null)

const prettyConfig = computed(() => JSON.stringify(config.value || {}, null, 2))

watch(isOpen, (open) => {
  if (open) loadConfig()
})

function formatMs(value?: number) {
  if (value == null) return 'n/a'
  if (value < 1000) return `${value} ms`
  const seconds = Math.floor(value / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${minutes % 60} min`
}

function formatDays(value?: number) {
  if (value == null) return 'n/a'
  const days = value / 86_400_000
  const normalized = Number.isInteger(days) ? days.toString() : Number(days.toFixed(2)).toString()
  return `${normalized} Tage`
}

async function loadConfig() {
  loading.value = true
  error.value = null
  try {
    const res = await $fetch<ConfigResponse>('/api/_workflows/config')
    config.value = res?.config || null
  } catch (e: any) {
    error.value = e?.statusMessage || e?.message || 'Failed to load workflow config'
  } finally {
    loading.value = false
  }
}
</script>
