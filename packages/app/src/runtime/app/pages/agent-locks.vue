<script setup lang="ts">
import { computed, ref, useFetch, useComponentRouter } from '#imports'

interface AgentPermit {
  owner: string
  key: string
  limit: number
  run_id: string
  node_uid: string
  attempt: number
  session_id?: string | null
  turn_id?: string | null
  dispatch_uncertain: boolean
  event_claimed: boolean
}

interface PermitsResponse {
  permits: AgentPermit[]
  groups: { key: string, limit: number, active: number }[]
}

type PermitAction = 'check' | 'stop' | 'force_release'
interface ActionResponse {
  owner: string
  outcome: 'released' | 'retained' | 'not_found'
  message: string
}

const { push } = useComponentRouter()
const { data, status, error, refresh } = useFetch<PermitsResponse>('/api/_workflows/agent-permits')
const selectedGroup = ref('all')
const search = ref('')
const expandedOwners = ref<string[]>([])
const activeAction = ref<{ owner: string, action: PermitAction } | null>(null)
const refreshing = ref(false)
const accessDenied = ref(false)
const actionError = ref('')
const result = ref<ActionResponse | null>(null)
const target = ref<AgentPermit | null>(null)
const stopOpen = ref(false)
const forceOpen = ref(false)
const confirmation = ref('')
const reason = ref('')
const acknowledged = ref(false)
const clipboardMessage = ref('')

function statusCode(failure: unknown): number | undefined {
  const details = failure as { statusCode?: number, status?: number, response?: { status?: number } } | null
  return details?.statusCode ?? details?.status ?? details?.response?.status
}

function errorMessage(failure: unknown, fallback: string): string {
  const details = failure as { data?: { statusMessage?: string, message?: string } } | null
  const message = details?.data?.statusMessage ?? details?.data?.message
  return typeof message === 'string' && message.trim() ? message : fallback
}

const unavailable = computed(() => accessDenied.value || statusCode(error.value) === 403)
const busy = computed(() => !!activeAction.value || refreshing.value || status.value === 'pending')
const actionsDisabled = computed(() => busy.value || unavailable.value || !!error.value)
const permits = computed(() => data.value?.permits ?? [])
const groups = computed(() => data.value?.groups ?? [])
const groupOptions = computed(() => [
  { label: 'All groups', value: 'all' },
  ...groups.value.map(group => ({
    label: `${group.key} (${group.active}/${group.limit})`,
    value: `group:${group.key}`,
  })),
])
const filteredPermits = computed(() => {
  const query = search.value.trim().toLowerCase()
  return permits.value.filter(permit =>
    (selectedGroup.value === 'all' || selectedGroup.value === `group:${permit.key}`)
    && (!query || permit.run_id.toLowerCase().includes(query) || permit.owner.toLowerCase().includes(query)),
  )
})
const stats = computed(() => [
  { label: 'Active permits', count: permits.value.length },
  { label: 'Groups', count: groups.value.length },
  { label: 'Uncertain dispatches', count: permits.value.filter(permit => permit.dispatch_uncertain).length },
  { label: 'Event claims', count: permits.value.filter(permit => permit.event_claimed).length },
])
const canForceRelease = computed(() => !!target.value
  && confirmation.value === target.value.owner
  && !!reason.value.trim() && reason.value.length <= 2000
  && acknowledged.value
  && !actionsDisabled.value)

function toggleOwner(owner: string) {
  expandedOwners.value = expandedOwners.value.includes(owner)
    ? expandedOwners.value.filter(expanded => expanded !== owner)
    : [...expandedOwners.value, owner]
}

async function refreshSnapshot() {
  if (busy.value) return
  refreshing.value = true
  try {
    await refresh()
    if (!error.value) accessDenied.value = false
  }
  finally {
    refreshing.value = false
  }
}

function openModal(permit: AgentPermit, action: 'stop' | 'force_release') {
  if (actionsDisabled.value) return
  target.value = permit
  actionError.value = ''
  confirmation.value = ''
  reason.value = ''
  acknowledged.value = false
  clipboardMessage.value = ''
  stopOpen.value = action === 'stop'
  forceOpen.value = action === 'force_release'
}

async function copyOwner() {
  if (!target.value) return
  try {
    await navigator.clipboard.writeText(target.value.owner)
    clipboardMessage.value = 'Owner copied.'
  }
  catch {
    clipboardMessage.value = 'Clipboard unavailable. Select and copy the full owner above.'
  }
}

async function managePermit(permit: AgentPermit, action: PermitAction) {
  if (actionsDisabled.value || (action === 'force_release' && !canForceRelease.value)) return
  activeAction.value = { owner: permit.owner, action }
  actionError.value = ''
  result.value = null
  try {
    result.value = await $fetch<ActionResponse>('/api/_workflows/agent-permits', {
      method: 'POST',
      body: {
        owner: permit.owner,
        action,
        ...(action === 'force_release' ? { confirmation: confirmation.value, reason: reason.value.trim() } : {}),
      },
    })
    if (result.value.outcome !== 'retained') {
      stopOpen.value = false
      forceOpen.value = false
    }
  }
  catch (failure) {
    if (statusCode(failure) === 403) accessDenied.value = true
    actionError.value = statusCode(failure) === 403
      ? 'Agent permit management is disabled or access is not permitted. Check the server configuration.'
      : errorMessage(failure, 'The action failed. The permit may still be held; check its state before retrying.')
  }
  finally {
    try {
      await refresh()
    }
    finally {
      activeAction.value = null
    }
  }
}
</script>

<template>
  <div class="h-full min-w-0 flex flex-col overflow-hidden">
    <header class="shrink-0 border-b border-gray-200 dark:border-gray-800 px-6 py-3 flex items-center justify-between gap-3">
      <h1 class="text-lg font-semibold">Agent Locks</h1>
      <UTooltip text="Refresh permits">
        <UButton icon="i-lucide-refresh-cw" aria-label="Refresh permits" color="neutral" variant="ghost" size="sm" :loading="refreshing || status === 'pending'" :disabled="busy" @click="refreshSnapshot" />
      </UTooltip>
    </header>

    <div class="flex-1 min-h-0 overflow-y-auto">
      <div class="px-6 py-4 space-y-4">
        <UAlert v-if="unavailable" icon="i-lucide-shield-alert" color="warning" variant="subtle" title="Agent permit management unavailable" description="This feature is disabled or access is not permitted. Check the server configuration before retrying." />
        <UAlert v-else-if="error" icon="i-lucide-triangle-alert" color="error" variant="subtle" title="Could not refresh permits" description="The current permit state could not be loaded. Any previously loaded values may be stale. Refresh before taking action." />
        <UAlert v-if="actionError && !unavailable" icon="i-lucide-triangle-alert" color="error" variant="subtle" title="Action failed" :description="actionError" />
        <UAlert v-if="result" :icon="result.outcome === 'released' ? 'i-lucide-check' : 'i-lucide-info'" :color="result.outcome === 'retained' ? 'warning' : result.outcome === 'released' ? 'success' : 'neutral'" variant="subtle" :title="result.outcome === 'retained' ? 'Permit retained' : result.outcome === 'released' ? 'Permit released' : 'Permit not found'" :description="result.message" />

        <dl class="grid grid-cols-2 md:grid-cols-4 gap-4 border-b border-gray-200 dark:border-gray-800 pb-4">
          <div v-for="stat in stats" :key="stat.label">
            <dt class="text-xs text-gray-500 dark:text-gray-400">{{ stat.label }}</dt>
            <dd class="mt-1 text-xl font-semibold tabular-nums">{{ unavailable || (!data && error) ? '-' : stat.count }}</dd>
          </div>
        </dl>

        <div class="flex flex-wrap items-center gap-3">
          <USelect v-model="selectedGroup" :items="groupOptions" aria-label="Filter by concurrency group" class="w-full sm:w-72" />
          <UInput v-model="search" icon="i-lucide-search" placeholder="Search run or owner" aria-label="Search run or owner" class="w-full sm:w-80" />
          <span class="text-xs text-gray-500" role="status">{{ filteredPermits.length }} permits</span>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full min-w-[760px] text-sm text-left">
            <thead class="border-b border-gray-200 dark:border-gray-800 text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th scope="col" class="w-10 py-3"><span class="sr-only">Details</span></th>
                <th scope="col" class="px-3 py-3 font-medium">Group</th>
                <th scope="col" class="px-3 py-3 font-medium">Owner / Run</th>
                <th scope="col" class="px-3 py-3 font-medium">State</th>
                <th scope="col" class="px-3 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-800">
              <template v-for="permit in filteredPermits" :key="permit.owner">
                <tr class="align-top">
                  <td class="py-3">
                    <UTooltip :text="expandedOwners.includes(permit.owner) ? 'Hide technical IDs' : 'Show technical IDs'">
                      <UButton :icon="expandedOwners.includes(permit.owner) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" :aria-label="`Technical IDs for ${permit.owner}`" :aria-expanded="expandedOwners.includes(permit.owner)" color="neutral" variant="ghost" size="xs" @click="toggleOwner(permit.owner)" />
                    </UTooltip>
                  </td>
                  <td class="px-3 py-3 max-w-64 break-all">
                    <div class="font-medium">{{ permit.key }}</div>
                    <div class="text-xs text-gray-500 mt-1">Limit {{ permit.limit }}</div>
                  </td>
                  <td class="px-3 py-3 max-w-96">
                    <div class="font-mono text-xs break-all">{{ permit.owner }}</div>
                    <UButton variant="link" color="neutral" size="xs" class="px-0 mt-1 h-auto whitespace-normal text-left break-all" :label="permit.run_id" @click="push(`/workflows/runs/${encodeURIComponent(permit.run_id)}`)" />
                  </td>
                  <td class="px-3 py-3">
                    <div class="flex flex-wrap gap-1">
                      <UBadge v-if="permit.dispatch_uncertain" color="warning" variant="subtle">Dispatch uncertain</UBadge>
                      <UBadge v-if="permit.event_claimed" color="info" variant="subtle">Event claimed</UBadge>
                      <UBadge v-if="!permit.dispatch_uncertain && !permit.event_claimed" color="neutral" variant="subtle">Held</UBadge>
                    </div>
                  </td>
                  <td class="px-3 py-3">
                    <div class="flex justify-end gap-1">
                      <UTooltip text="Check whether this permit can be released">
                        <UButton icon="i-lucide-scan-line" aria-label="Check permit" color="neutral" variant="ghost" size="xs" :disabled="actionsDisabled" :loading="activeAction?.owner === permit.owner && activeAction?.action === 'check'" @click="managePermit(permit, 'check')" />
                      </UTooltip>
                      <UTooltip text="Stop owner workflow and agent">
                        <UButton icon="i-lucide-square" aria-label="Stop owner workflow and agent" color="warning" variant="ghost" size="xs" :disabled="actionsDisabled" @click="openModal(permit, 'stop')" />
                      </UTooltip>
                      <UTooltip text="Force release permit">
                        <UButton icon="i-lucide-lock-open" aria-label="Force release permit" color="error" variant="ghost" size="xs" :disabled="actionsDisabled" @click="openModal(permit, 'force_release')" />
                      </UTooltip>
                    </div>
                  </td>
                </tr>
                <tr v-if="expandedOwners.includes(permit.owner)">
                  <td colspan="5" class="px-4 py-4 bg-gray-50 dark:bg-gray-900/40">
                    <dl class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                      <div v-for="field in [{ label: 'Owner', value: permit.owner }, { label: 'Run ID', value: permit.run_id }, { label: 'Node UID', value: permit.node_uid }, { label: 'Attempt', value: permit.attempt }, { label: 'Session ID', value: permit.session_id ?? 'Not bound' }, { label: 'Turn ID', value: permit.turn_id ?? 'Not bound' }]" :key="field.label" class="min-w-0">
                        <dt class="text-gray-500 dark:text-gray-400">{{ field.label }}</dt>
                        <dd class="font-mono break-all mt-1">{{ field.value }}</dd>
                      </div>
                    </dl>
                  </td>
                </tr>
              </template>
              <tr v-if="!filteredPermits.length">
                <td colspan="5" class="py-10 text-center text-gray-500" role="status">{{ status === 'pending' ? 'Loading permits...' : unavailable || error ? 'Permit state unavailable.' : permits.length ? 'No permits match these filters.' : 'No active agent permits.' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <UModal v-model:open="stopOpen" title="Stop owner workflow and agent" :dismissible="!activeAction" :close="!activeAction">
      <template #body>
        <div class="space-y-4">
          <UAlert icon="i-lucide-triangle-alert" color="warning" variant="subtle" title="This cancels the entire owner workflow and its agent." description="The permit remains held unless the server can confirm that releasing it is safe." />
          <p class="font-mono text-xs break-all">{{ target?.owner }}</p>
          <UAlert v-if="actionError" color="error" title="Stop failed" :description="actionError" />
          <UAlert v-if="result?.owner === target?.owner && result?.outcome === 'retained'" color="warning" title="Permit retained" :description="result.message" />
        </div>
      </template>
      <template #footer>
        <div class="flex flex-wrap justify-end gap-2 w-full">
          <UButton color="neutral" variant="ghost" :disabled="!!activeAction" @click="stopOpen = false">Cancel</UButton>
          <UButton icon="i-lucide-square" color="warning" :disabled="actionsDisabled" :loading="activeAction?.action === 'stop'" @click="target && managePermit(target, 'stop')">Stop workflow and agent</UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="forceOpen" title="Force release permit" :dismissible="!activeAction" :close="!activeAction">
      <template #body>
        <div class="space-y-4">
          <UAlert icon="i-lucide-triangle-alert" color="error" variant="subtle" title="Remote execution may still be running." description="Force release does not stop the remote agent. The owner run must be terminal; the server rejects non-terminal runs." />
          <div class="flex items-start gap-2">
            <p class="flex-1 min-w-0 font-mono text-xs break-all select-all">{{ target?.owner }}</p>
            <UTooltip text="Copy full owner">
              <UButton icon="i-lucide-copy" aria-label="Copy full owner" color="neutral" variant="ghost" size="xs" @click="copyOwner" />
            </UTooltip>
          </div>
          <p v-if="clipboardMessage" class="text-xs text-gray-500" role="status">{{ clipboardMessage }}</p>
          <UFormField label="Full owner confirmation" required>
            <UInput v-model="confirmation" aria-label="Full owner confirmation" autocomplete="off" class="w-full" :disabled="!!activeAction" />
          </UFormField>
          <UFormField label="Reason" required>
            <UTextarea v-model="reason" aria-label="Force release reason" maxlength="2000" class="w-full" :disabled="!!activeAction" />
          </UFormField>
          <UCheckbox v-model="acknowledged" label="I acknowledge that the remote session may still be running and could exceed the concurrency limit after release." :disabled="!!activeAction" />
          <UAlert v-if="actionError" color="error" title="Force release failed" :description="actionError" />
          <UAlert v-if="result?.owner === target?.owner && result?.outcome === 'retained'" color="warning" title="Permit retained" :description="result.message" />
        </div>
      </template>
      <template #footer>
        <div class="flex flex-wrap justify-end gap-2 w-full">
          <UButton color="neutral" variant="ghost" :disabled="!!activeAction" @click="forceOpen = false">Cancel</UButton>
          <UButton icon="i-lucide-lock-open" color="error" :disabled="!canForceRelease" :loading="activeAction?.action === 'force_release'" @click="target && managePermit(target, 'force_release')">Force release</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>