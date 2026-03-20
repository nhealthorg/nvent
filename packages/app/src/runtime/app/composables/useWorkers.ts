import { ref, useFetch, onUnmounted, type Ref } from '#imports'
import type { FetchError } from 'ofetch'

export interface WorkerInfo {
  id: string
  name: string | null
  status: 'connected' | 'disconnected' | string
  runtime: 'rust' | 'node' | 'python' | string | null
  version: string | null
  os: string | null
  pid: number | null
  ip_address: string
  connected_at_ms: number
  active_invocations: number
  function_count: number
  functions: string[]
  latest_metrics: WorkerMetrics | null
}

export interface WorkerMetrics {
  cpu_percent: number
  memory_heap_used: number
  memory_heap_total: number
  memory_rss: number
  memory_external: number
  cpu_user_micros: number
  cpu_system_micros: number
  event_loop_lag_ms: number
  uptime_seconds: number
  timestamp_ms: number
  runtime: string
}

export interface HealthComponent {
  status: string
  details: Record<string, unknown>
}

export interface EngineHealth {
  status: string
  version: string
  timestamp: number
  components: Record<string, HealthComponent>
}

export interface WorkersData {
  health: EngineHealth | null
  healthError: string | null
  workers: WorkerInfo[]
  workersError: string | null
}

/**
 * Composable for fetching engine health + worker list.
 * Polls every 5 seconds to give a live production view.
 */
export function useWorkers(pollIntervalMs = 5000): {
  data: Ref<WorkersData | null | undefined>
  refresh: () => Promise<void>
  status: Ref<'idle' | 'pending' | 'success' | 'error'>
  error: Ref<FetchError | null | undefined>
  engineOnline: Ref<boolean>
} {
  const refreshCounter = ref(0)

  const { data, refresh: _refresh, status, error } = useFetch<WorkersData>(
    () => `/api/_workers?_t=${refreshCounter.value}`,
    {
      immediate: false,
      watch: false,
      server: false,
    },
  )

  const refresh = async () => {
    refreshCounter.value++
    await _refresh()
  }

  const engineOnline = ref(false)

  const checkOnline = () => {
    engineOnline.value = !!data.value?.health && !data.value?.healthError
  }

  let timer: ReturnType<typeof setInterval> | undefined

  const stopPolling = () => {
    if (timer !== undefined) { clearInterval(timer); timer = undefined }
  }

  if (import.meta.client) {
    refresh().then(checkOnline)
    timer = setInterval(async () => {
      await refresh()
      checkOnline()
    }, pollIntervalMs)
    onUnmounted(stopPolling)
  }

  return {
    data,
    refresh,
    status,
    error,
    engineOnline,
  }
}
