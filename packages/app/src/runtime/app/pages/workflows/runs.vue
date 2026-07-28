<script setup lang="ts">
import { computed, ref, useFetch, useComponentRouter, onMounted, onUnmounted, watch, useRoute } from '#imports'
import type { TableColumn, TableRow } from '@nuxt/ui'
import { h, resolveComponent } from 'vue'
import { type WorkflowRunRecord, RunStatus, type NodeCheckpoint } from '#nvent/types'

const UBadge = resolveComponent('UBadge')
const UProgress = resolveComponent('UProgress')
const UButton = resolveComponent('UButton')

interface RunsResponse {
  runs: WorkflowRunRecord[]
  pagination: {
    total: number
    limit: number
    offset: number
  }
}

const { push } = useComponentRouter()
const route = useRoute()

const status = ref((route.query.status as string) || 'all')
const workflow = ref((route.query.workflow as string) || 'all')
const page = ref(Number(route.query.page) || 1)
const limit = ref(20)

const params = computed(() => ({
  status: (status.value && status.value !== 'all') ? status.value : undefined,
  workflow: (workflow.value && workflow.value !== 'all') ? workflow.value : undefined,
  limit: limit.value,
  offset: (page.value - 1) * limit.value
}))

const { data, refresh, pending } = useFetch<RunsResponse>('/api/_workflows/runs', {
  query: params
})

const { data: workflowOptions } = useFetch('/api/_workflows', {
  transform: (data: any) => {
    const options = [{ label: 'All Workflows', id: 'all' }]
    if (data?.definitions) {
      data.definitions.forEach((d: any) => {
        options.push({ label: d.id, id: d.id })
      })
    }
    return options
  }
})

// Reset to page 1 when filters change
watch([status, workflow], () => {
  page.value = 1
})

const runs = computed(() => data.value?.runs || [])
const total = computed(() => data.value?.pagination?.total || 0)
const cancelingRunIds = ref<string[]>([])
const deletingRunIds = ref<string[]>([])
const cancelError = ref<string | null>(null)
const deleteError = ref<string | null>(null)
const deleteModalOpen = ref(false)
const deleteTarget = ref<{ runId: string, workflowName: string } | null>(null)

// Auto-refresh only if on first page and no specific search active
let refreshInterval: any = null
onMounted(() => {
  refreshInterval = setInterval(() => {
    if (page.value === 1 && (!workflow.value || workflow.value === 'all')) {
      refresh()
    }
  }, 5000)
})

onUnmounted(() => {
  if (refreshInterval) clearInterval(refreshInterval)
})

const statusOptions = ref([
  { label: 'All Statuses', id: 'all' },
  { label: 'Running', id: RunStatus.AwaitingNodes },
  { label: 'Completed', id: RunStatus.Completed },
  { label: 'Failed', id: RunStatus.Failed },
  { label: 'Cancelled', id: RunStatus.Cancelled }
])

function statusLabel(status: string) {
  if (status === 'all') return 'ALL STATUSES'
  return status === 'awaiting_nodes' ? 'RUNNING' : (status || '').toUpperCase()
}

function statusColor(status: string) {
  if (status === 'completed' || status === 'done') return 'success'
  if (status === 'failed' || status === 'error' || status === 'cancelled') return 'error'
  if (status === 'running' || status === 'active' || status === 'awaiting_nodes' || status === 'awaiting') return 'info'
  return 'neutral'
}

function isLiveStatus(status: string) {
  return status === 'running' || status === 'active' || status === 'awaiting_nodes' || status === 'awaiting'
}

function isTerminalStatus(status: string) {
  return status === RunStatus.Completed || status === RunStatus.Failed || status === RunStatus.Cancelled
}

async function cancelRun(runId: string) {
  if (cancelingRunIds.value.includes(runId)) return
  cancelError.value = null
  cancelingRunIds.value = [...cancelingRunIds.value, runId]
  try {
    await $fetch('/api/_workflows/stop', {
      method: 'POST',
      body: { run_id: runId },
    })
    await refresh()
  }
  catch (error: any) {
    cancelError.value = error?.data?.statusMessage || error?.message || 'Cancel failed'
  }
  finally {
    cancelingRunIds.value = cancelingRunIds.value.filter(id => id !== runId)
  }
}

function openDeleteModal(run: WorkflowRunRecord) {
  const currentStatus = String(run.status || '')
  if (!isTerminalStatus(currentStatus)) return
  deleteTarget.value = {
    runId: run.run_id,
    workflowName: run.workflow_name || run.def_ref,
  }
  deleteModalOpen.value = true
}

async function confirmDeleteRun() {
  const target = deleteTarget.value
  if (!target) return
  if (deletingRunIds.value.includes(target.runId)) return

  deleteError.value = null
  deletingRunIds.value = [...deletingRunIds.value, target.runId]
  try {
    await $fetch('/api/_workflows/delete', {
      method: 'POST',
      body: { run_id: target.runId },
    })
    deleteModalOpen.value = false
    deleteTarget.value = null
    await refresh()
  }
  catch (error: any) {
    deleteError.value = error?.data?.statusMessage || error?.message || 'Delete failed'
  }
  finally {
    deletingRunIds.value = deletingRunIds.value.filter(id => id !== target.runId)
  }
}

const columns: TableColumn<WorkflowRunRecord>[]  = [
  {
    id: 'workflow',
    accessorFn: row => row.workflow_name || row.def_ref,
    header: 'Workflow',
    cell: ({ row }) => {
      const run = row.original
      return h('div', { class: 'flex flex-col min-w-0 py-1' }, [
        h('div', { class: 'flex items-center gap-2' }, [
          h('span', { class: 'text-sm font-semibold text-zinc-900 dark:text-white truncate lg:max-w-[300px]' }, run.workflow_name || run.def_ref),
          run.workflow_trace_id ? h(UBadge, { label: 'Trace', size: 'xs', variant: 'subtle', color: 'gray', class: 'text-[9px] px-1 py-0' }) : null
        ]),
        h('span', { class: 'text-[10px] font-mono text-zinc-400 truncate' }, run.run_id)
      ])
    }
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => {
      const status = String(row.original.status || '')
      return h(UBadge, {
        label: statusLabel(status),
        size: 'xs',
        color: statusColor(status),
        variant: 'soft',
        class: 'font-bold'
      })
    }
  },
  {
    id: 'progress',
    header: 'Progress',
    cell: ({ row }) => {
      const p = getNodesProgress(row.original)
      if (p.total === 0) return h('span', { class: 'text-xs text-zinc-400' }, 'Starting...')
      
      return h('div', { class: 'flex flex-col gap-1 w-24' }, [
        h('div', { class: 'flex items-center justify-between text-[10px] text-zinc-500' }, [
          h('span', `${p.finished}/${p.total}`),
          h('span', `${p.percent}%`)
        ]),
        h(UProgress, {
          modelValue: p.percent,
          size: 'xs',
          color: statusColor(row.original.status) as any
        })
      ])
    }
  },
  {
    id: 'duration',
    header: 'Duration',
    cell: ({ row }) => h('div', { class: 'flex flex-col' }, [
        h('span', { class: 'text-xs text-zinc-700 dark:text-zinc-300 font-medium' }, formatDuration(row.original)),
        h('span', { class: 'text-[10px] text-zinc-400' }, formatDate(Number(row.original.created_at)))
    ])
  },
  {
    id: 'actions',
    header: '',
    cell: ({ row }) => {
      const run = row.original
      const currentStatus = String(run.status || '')
      const isLive = isLiveStatus(currentStatus)
      const isTerminal = isTerminalStatus(currentStatus)
      const isCancelling = cancelingRunIds.value.includes(run.run_id)
      const isDeleting = deletingRunIds.value.includes(run.run_id)

      return h('div', { class: 'flex items-center justify-end gap-2 pr-2' }, [
        isLive
          ? h(UButton, {
              size: 'xs',
              color: 'error',
              variant: 'ghost',
              icon: 'i-lucide-x-circle',
              label: 'Cancel',
              loading: isCancelling,
              onClick: async (event: Event) => {
                event.stopPropagation()
                await cancelRun(run.run_id)
              },
            })
          : null,
        isTerminal
          ? h(UButton, {
              size: 'xs',
              color: 'neutral',
              variant: 'ghost',
              icon: 'i-lucide-trash-2',
              loading: isDeleting,
              title: 'Delete run',
              onClick: async (event: Event) => {
                event.stopPropagation()
                openDeleteModal(run)
              },
            })
          : null,
        h('span', { class: 'text-zinc-300 dark:text-zinc-700' }, '›'),
      ])
    }
  }
]

function formatDate(timestamp: number) {
  if (!timestamp) return 'n/a'
  return new Date(timestamp).toLocaleString()
}

function getNodesProgress(run: WorkflowRunRecord) {
  const nodeEntries = Object.entries(run.nodes || {}) as Array<[string, NodeCheckpoint]>
  if (nodeEntries.length === 0) return { finished: 0, total: 0, percent: 0 }

  // Loop fanout creates node ids like "step#0", while the base id can remain non-terminal.
  // Exclude base nodes when itemized children exist to avoid under-reporting progress.
  const loopBaseIds = new Set(
    nodeEntries
      .filter(([id]) => id.includes('#'))
      .map(([id]) => id.split('#')[0])
      .filter((id): id is string => Boolean(id))
  )

  const effectiveNodes = nodeEntries
    .filter(([id]) => !(loopBaseIds.has(id) && !id.includes('#')))
    .map(([, node]) => node)

  if (effectiveNodes.length === 0) return { finished: 0, total: 0, percent: 0 }

  const finished = effectiveNodes.filter(n => n.state === 'done' || n.state === 'failed' || n.state === 'cancelled').length
  return {
    finished,
    total: effectiveNodes.length,
    percent: Math.round((finished / effectiveNodes.length) * 100)
  }
}

function formatDuration(run: WorkflowRunRecord) {
  const end = run.status === RunStatus.Running || run.status === RunStatus.AwaitingNodes 
    ? Date.now() 
    : run.updated_at
  const diff = end - run.created_at
  if (diff < 0) return '0s'
  if (diff < 1000) return `${diff}ms`
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <UModal v-model:open="deleteModalOpen" title="Delete Run">
      <template #body>
        <div class="space-y-2">
          <p class="text-sm text-zinc-700 dark:text-zinc-200">
            Diesen terminalen Run inklusive zugehoeriger Artefakte loeschen?
          </p>
          <p v-if="deleteTarget" class="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
            {{ deleteTarget.workflowName }} - {{ deleteTarget.runId }}
          </p>
        </div>
      </template>
      <template #footer>
        <div class="w-full flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            label="Abbrechen"
            @click="deleteModalOpen = false"
          />
          <UButton
            color="error"
            variant="solid"
            label="Loeschen"
            :loading="deleteTarget ? deletingRunIds.includes(deleteTarget.runId) : false"
            @click="confirmDeleteRun"
          />
        </div>
      </template>
    </UModal>

    <!-- Header -->
    <div class="border-b border-zinc-200 dark:border-zinc-800 px-6 py-4 shrink-0 bg-white dark:bg-zinc-950">
      <div class="flex items-center justify-between max-w-7xl mx-auto w-full">
        <div class="flex items-center gap-4">
          <UButton
            icon="i-heroicons-chevron-left"
            color="gray"
            variant="ghost"
            @click="push(`/workflows`)"
          />
          <div>
            <h1 class="text-xl font-bold text-zinc-900 dark:text-white">
              Workflow Runs
            </h1>
            <p class="text-xs text-zinc-500 dark:text-zinc-400">History of all executed pipelines</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <USelectMenu
            v-model="workflow"
            :items="workflowOptions"
            value-key="id"
            label-key="label"
            placeholder="Search workflow..."
            size="sm"
            class="w-48"
            searchable
          />
          <USelectMenu
            v-model="status"
            :items="statusOptions"
            value-key="id"
            label-key="label"
            placeholder="All Statuses"
            size="sm"
            class="w-36"
          />
          <UButton
            icon="i-heroicons-arrow-path"
            color="gray"
            variant="ghost"
            :loading="pending"
            @click="refresh"
          />
        </div>
      </div>
    </div>

    <!-- Content -->
    <div class="flex-1 min-h-0 overflow-y-auto">
      <div class="max-w-7xl mx-auto p-6">
        <div v-if="cancelError" class="mb-3 text-xs text-red-600 dark:text-red-400">
          {{ cancelError }}
        </div>
        <div v-if="deleteError" class="mb-3 text-xs text-red-600 dark:text-red-400">
          {{ deleteError }}
        </div>
        <div class="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden shadow-sm">
          <UTable
            ref="table"
            :data="runs"
            :columns="columns"
            :loading="pending"
            @select="(e: Event, row: TableRow<WorkflowRunRecord>) => push(`/workflows/runs/${row.original.run_id}`)"
            :ui="{
              wrapper: 'overflow-x-auto',
              thead: {
                wrapper: 'bg-zinc-50 dark:bg-zinc-900/50',
                tr: {
                  base: 'text-zinc-500 dark:text-zinc-400 text-xs font-medium uppercase tracking-wider'
                }
              },
              tbody: {
                tr: {
                  base: 'hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors cursor-pointer'
                }
              }
            }"
          />

          <!-- Pagination -->
          <div v-if="total > limit" class="px-6 py-4 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between bg-zinc-50/50 dark:bg-zinc-900/20">
            <span class="text-xs text-zinc-500">
              Showing {{ (page - 1) * limit + 1 }} to {{ Math.min(page * limit, total) }} of {{ total }} runs
            </span>
            <UPagination
              v-model:page="page"
              :total="total"
              :items-per-page="limit"
              size="xs"
              color="gray"
              @update:model-value="(p: number) => page = p"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
