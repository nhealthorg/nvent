import { ref, onMounted, onUnmounted } from 'vue'

export interface Workflow {
  id: string
  description?: string
  triggers: any[]
  filePath: string
}

export interface WorkflowRunStatus {
  invocation_id: string
  workflow_id: string
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  started_at: string
  updated_at: string
}

export function useWorkflows() {
  const definitions = ref<Workflow[]>([])
  const activeRuns = ref<WorkflowRunStatus[]>([])
  const loading = ref(true)
  const error = ref<any>(null)
  
  let pollTimer: any = null

  async function fetchWorkflows() {
    try {
      loading.value = definitions.value.length === 0
      const data = await $fetch<any>('/api/_workflows')
      
      if (data) {
        definitions.value = data.definitions || []
        activeRuns.value = data.active_runs || []
      }
    } catch (e) {
      console.error('Failed to fetch workflows:', e)
      error.value = e
    } finally {
      loading.value = false
    }
  }

  onMounted(() => {
    fetchWorkflows()
    pollTimer = setInterval(fetchWorkflows, 10000)
  })

  onUnmounted(() => {
    if (pollTimer) clearInterval(pollTimer)
  })

  return {
    definitions,
    activeRuns,
    loading,
    error,
    refresh: fetchWorkflows
  }
}
