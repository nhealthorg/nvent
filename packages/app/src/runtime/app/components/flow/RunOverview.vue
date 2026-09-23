<template>
  <div class="flex flex-col h-full w-full max-w-full min-w-0">
    <!-- Fixed Header with Run Stats -->
    <div class="h-[72px] px-6 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 shrink-0 flex items-center justify-between gap-3">
      <!-- Top Row: Status and Action -->
      <div class="min-w-0 flex-1 flex items-center gap-2">
        <div
          class="w-2 h-2 rounded-full flex-shrink-0"
          :class="getStatusColor(runStatus)"
        />
        <span class="text-sm font-semibold text-gray-900 dark:text-gray-100 capitalize truncate">
          {{ runStatus || 'unknown' }}
        </span>
        <span
          v-if="triggerName"
          class="text-xs text-gray-500 dark:text-gray-400 truncate"
        >
          via {{ triggerName }}
        </span>
        <span
          v-if="runStatus === 'running'"
          class="flex items-center gap-1 ml-1"
        >
          <div class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span class="text-xs text-gray-500 dark:text-gray-400">Live</span>
        </span>
      </div>
 
      <!-- Cancel Button (only show for running/awaiting flows) -->
      <div class="flex items-center gap-2 flex-shrink-0 self-start pt-0.5">
        <UButton
          v-if="runStatus === 'running' || runStatus === 'awaiting'"
          color="neutral"
          variant="ghost"
          icon="i-lucide-x-circle"
          size="xs"
          label="Cancel"
          @click="handleCancelFlow"
        />
        <!-- Restart Button (show for terminal states) -->
        <UButton
          v-if="runStatus === 'failed' || runStatus === 'stalled' || runStatus === 'canceled' || runStatus === 'completed'"
          color="primary"
          variant="ghost"
          icon="i-lucide-rotate-ccw"
          size="xs"
          label="Restart"
          @click="handleRestartFlow"
        />
      </div>
    </div>

    <div class="px-3 py-2 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-zinc-900 shrink-0">
      <div class="flex items-center gap-1.5 min-w-0">
        <div
          v-for="item in primaryOverviewFacts"
          :key="item.label"
          :title="item.title || item.value"
          class="inline-flex min-h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50/90 dark:bg-zinc-950 px-2 py-1.5 text-xs"
        >
          <UIcon :name="item.icon" class="w-3.5 h-3.5 shrink-0" :class="item.iconClass" />
          <span class="truncate text-gray-800 dark:text-gray-100 font-medium">{{ item.value }}</span>
        </div>

        <UPopover v-if="additionalOverviewFacts.length > 0" :content="{ align: 'end', side: 'bottom', sideOffset: 8 }">
          <UButton
            icon="i-lucide-ellipsis"
            color="neutral"
            variant="subtle"
            size="sm"
            square
            aria-label="Show run details"
          />
          <template #content>
            <div class="w-64 p-3">
              <div class="mb-2 text-xs font-semibold text-gray-900 dark:text-gray-100">Run details</div>
              <div class="space-y-2">
                <div v-for="item in additionalOverviewFacts" :key="item.label" class="flex items-start gap-2 text-xs">
                  <UIcon :name="item.icon" class="mt-0.5 h-3.5 w-3.5 shrink-0" :class="item.iconClass" />
                  <div class="min-w-0">
                    <div class="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{{ item.label }}</div>
                    <div class="break-words text-gray-800 dark:text-gray-100">{{ item.value }}</div>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </UPopover>
      </div>
    </div>

    <!-- Scrollable Steps List -->
    <div class="min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 sm:px-4">
      <div
        v-if="steps.length === 0 && lifecycleEventItems.length === 0"
        class="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500"
      >
        <UIcon
          name="i-lucide-layers"
          class="w-12 h-12 mb-3 opacity-50"
        />
        <span class="text-sm">No steps executed yet</span>
      </div>

      <FlowStepSelector
        v-else
        v-model="selectedStep"
        :items="radioItems"
        @inspect-step-result="emit('inspect-step-result', $event)"
        @open-child-run="emit('open-child-run', $event)"
        @view-child-runs="emit('view-child-runs', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from '#imports'
import FlowStepSelector from './StepSelector.vue'

const props = defineProps<{
  runStatus?: string
  startedAt?: string | number
  completedAt?: string | number
  steps: any[]
  flowName?: string
  runId?: string
  triggerName?: string
  triggerType?: 'manual' | 'event' | 'webhook' | 'schedule'
  flowDef?: any
  stallTimeout?: number
  loopOverview?: {
    loops: number
    expandedLoops: number
    totalItems: number
    completedItems: number
  }
  resultOverview?: {
    readyMemory: number
    readyStore: number
    readyStream: number
    prunedMemory: number
    pending: number
  }
  runResultMode?: 'memory' | 'store' | 'stream' | 'none'
  storeKey?: string
}>()

const emit = defineEmits<{
  'select-step': [stepKey: string | null]
  'cancel-flow': []
  'restart-flow': []
  'inspect-step-result': [stepKey: string]
  'open-child-run': [payload: { runId: string }]
  'view-child-runs': [runs: Array<{ index: number, runId: string, status: string }>]
}>()

const executableStepCount = computed(() => props.steps.filter(step => !step?.isLoopGroup).length)

type OverviewFact = {
  label: string
  value: string
  icon: string
  iconClass: string
  title?: string
}

const compactResultModeLabel = (mode: NonNullable<typeof props.runResultMode>) => {
  if (mode === 'store') return 'store'
  if (mode === 'stream') return 'stream'
  return 'memory'
}

const overviewFacts = computed(() => {
  const facts: OverviewFact[] = [
    {
      label: 'steps',
      value: `${executableStepCount.value} steps`,
      icon: 'i-lucide-layers',
      iconClass: 'text-gray-400',
      title: 'Executable workflow steps',
    },
    {
      label: 'timing',
      value: props.startedAt
        ? `${formatTime(props.startedAt)} · ${getDuration(props.startedAt, props.completedAt)}`
        : 'not started',
      icon: 'i-lucide-timer',
      iconClass: 'text-gray-400',
      title: 'Start time and total duration',
    },
  ]

  if ((props.loopOverview?.loops || 0) > 0) {
    facts.push({
      label: 'loops',
      value: `loops ${props.loopOverview?.expandedLoops || 0}/${props.loopOverview?.loops || 0} · items ${props.loopOverview?.completedItems || 0}/${props.loopOverview?.totalItems || 0}`,
      icon: 'i-heroicons-arrow-path-rounded-square-20-solid',
      iconClass: 'text-cyan-500',
      title: 'Expanded loops and processed loop items',
    })
  }

  if ((props.runStatus === 'running' || props.runStatus === 'awaiting') && props.stallTimeout) {
    facts.push({
      label: 'stall',
      value: `stall in ${formatStallTimeout(props.startedAt, props.stallTimeout)}`,
      icon: 'i-lucide-alert-triangle',
      iconClass: 'text-amber-500',
      title: 'Estimated time to stall timeout',
    })
  }

  if (props.runResultMode && props.runResultMode !== 'none') {
    facts.push({
      label: 'run-result-mode',
      value: `run result ${compactResultModeLabel(props.runResultMode)}`,
      icon: props.runResultMode === 'store' ? 'i-lucide-database' : props.runResultMode === 'stream' ? 'i-lucide-waves' : 'i-lucide-memory-stick',
      iconClass: props.runResultMode === 'store' ? 'text-emerald-600' : props.runResultMode === 'stream' ? 'text-sky-500' : 'text-amber-500',
      title: 'Workflow output storage mode',
    })
  }

  if (props.resultOverview) {
    facts.push({
      label: 'node-results',
      value: `node results s:${props.resultOverview.readyStore} m:${props.resultOverview.readyMemory} p:${props.resultOverview.prunedMemory}`,
      icon: 'i-lucide-file-json',
      iconClass: 'text-indigo-500',
      title: 'Ready store/memory node results and pruned memory results',
    })
  }

  return facts
})

const primaryOverviewFacts = computed(() => overviewFacts.value.slice(0, 3))
const additionalOverviewFacts = computed(() => overviewFacts.value.slice(3))

// Handle cancel flow action
const handleCancelFlow = () => {
  emit('cancel-flow')
}

// Handle restart flow action
const handleRestartFlow = () => {
  emit('restart-flow')
}

// Selected step ('all-steps' = all steps, null would break URadioGroup)
const selectedStep = ref<string>('all-steps')

// Track the first step key to detect run changes
const firstStepKey = computed(() => props.steps?.length > 0 ? props.steps[0]?.key : undefined)

// Reset selection only when run changes (first step key changes), not when new events arrive
watch(firstStepKey, (newKey, oldKey) => {
  // Only reset if first step actually changed (indicating a new run)
  if (oldKey !== undefined && newKey !== oldKey) {
    selectedStep.value = 'all-steps'
  }
})

// Watch selection and emit to parent
watch(selectedStep, (newStep: string) => {
  // Convert 'all-steps' to null for parent
  emit('select-step', newStep === 'all-steps' ? null : newStep)
})

// Check if an await step exists in the flow configuration
const isValidAwaitStep = (stepKey: string): boolean => {
  if (!stepKey.includes(':await-')) return true
  if (!props.flowDef) return false

  const parts = stepKey.split(':await-')
  const stepName = parts[0]
  const position = parts[1] // 'before' or 'after'

  // Check entry step
  if (props.flowDef.entry?.step === stepName) {
    if (position === 'after' && props.flowDef.entry?.awaitAfter) return true
    if (position === 'before' && props.flowDef.entry?.awaitBefore) return true
  }

  // Check regular steps
  const step = stepName ? props.flowDef.steps?.[stepName] : undefined
  if (step) {
    if (position === 'after' && step.awaitAfter) return true
    if (position === 'before' && step.awaitBefore) return true
  }

  return false
}

const lifecycleEventItems = computed(() => {
  const hooks = props.flowDef?.metadata?.hooks
  if (!hooks || typeof hooks !== 'object') return []

  const labels: Record<string, string> = {
    on_start: 'Workflow started',
    on_end: 'Workflow completed',
    on_error: 'Workflow failed',
    on_delete: 'Workflow deleted',
  }

  return (['on_start', 'on_end', 'on_error', 'on_delete'] as const).flatMap((event) => {
    const spec = hooks[event]
    if (!spec) return []

    const functionId = typeof spec === 'string' ? spec : spec?.function
    if (!functionId) return []

    const value = `lifecycle:${event}`
    return [{
      value,
      label: labels[event],
      step: {
        key: value,
        label: labels[event],
        functionId,
        lifecycleEvent: event,
        nodeKind: 'workflow_event',
        status: 'configured',
      },
      clickable: true,
    }]
  })
})

// Transform steps into radio items with "All Steps" option
const radioItems = computed(() => {
  const allItem = {
    value: 'all-steps',
    label: 'All Steps',
    step: {
      key: 'All Steps',
      status: null,
      showAllIndicator: true,
    },
    clickable: true,
  }

  // Filter steps to only include valid await steps
  const filteredSteps = props.steps.filter(step => isValidAwaitStep(step.key))

  const stepItems = filteredSteps.map((step) => {
    const isAwait = step.key.includes(':await-')
    const isLoopGroup = Boolean(step.isLoopGroup)

    // Get await config from flow definition for await steps
    let awaitConfig = undefined
    let webhookUrl = undefined
    if (isAwait && props.flowDef) {
      const parts = step.key.split(':await-')
      const stepName = parts[0]
      const position = parts[1] // 'before' or 'after'

      // Check entry step
      if (props.flowDef.entry?.step === stepName) {
        awaitConfig = position === 'after' ? props.flowDef.entry?.awaitAfter : props.flowDef.entry?.awaitBefore
      }
      // Check regular steps
      else {
        const stepDef = stepName ? props.flowDef.steps?.[stepName] : undefined
        if (stepDef) {
          awaitConfig = position === 'after' ? stepDef.awaitAfter : stepDef.awaitBefore
        }
      }

      // Construct webhook URL if it's a webhook await
      if (awaitConfig?.type === 'webhook' && props.flowName && props.runId) {
        // Get base URL from window location
        const baseUrl = typeof window !== 'undefined'
          ? `${window.location.protocol}//${window.location.host}`
          : ''
        webhookUrl = `${baseUrl}/api/_webhook/await/${props.flowName}/${props.runId}/${stepName}`
      }
    }

    const finalStep = {
      ...step,
      loopChildren: isLoopGroup
        ? filteredSteps
          .filter(child => child.inLoopGroup && child.loopGroupId === step.loopGroupId)
          .map(child => ({
            value: child.key,
            label: child.label || child.key,
            step: child,
          }))
        : undefined,
      awaitConfig, // Add await config from flow definition
      // Extract awaitType from config if available
      awaitType: awaitConfig?.type || step.awaitType,
      webhookUrl, // Add constructed webhook URL
    }

    return {
      value: step.key,
      label: step.key,
      step: finalStep,
      clickable: !isAwait && !isLoopGroup,
    }
  })

  const reduceItems = stepItems.filter(item => item.step?.nodeKind === 'reduce')
  const reduceBodyItems = stepItems.filter(item => item.step?.nodeKind === 'reduce_body')
  const groupedReduceItems = reduceItems.map((reduceItem) => ({
    ...reduceItem,
    clickable: false,
    step: {
      ...reduceItem.step,
      nodeKind: 'reduce_group',
      bodyItems: reduceBodyItems.filter(item => item.step?.reduceBody?.reduce === reduceItem.value),
    },
  }))
  const reduceBodyValues = new Set(reduceBodyItems.map(item => item.value))
  const reduceByValue = new Map(groupedReduceItems.map(item => [item.value, item]))

  const reduceVisibleItems = stepItems.flatMap(item => {
    if (reduceBodyValues.has(item.value)) return []
    return reduceByValue.get(item.value) || item
  })
  const ifItems = reduceVisibleItems.filter(item => item.step?.nodeKind === 'if')
  const branchItems = reduceVisibleItems.filter(item => item.step?.ifBranch?.if)
  const branchValues = new Set(branchItems.map(item => item.value))
  const groupedIfItems = ifItems.map((ifItem) => {
    const nestedLoopGroups = new Map(
      reduceVisibleItems
        .filter(item => item.step?.isLoopGroup && item.step?.ifBranch?.if === ifItem.value)
        .map(loopItem => [loopItem.value, {
          ...loopItem,
          step: {
            ...loopItem.step,
            loopChildren: stepItems
              .filter(child => child.step?.inLoopGroup && child.step?.loopGroupId === loopItem.step.loopGroupId)
              .map(child => ({ value: child.value, label: child.label, step: child.step })),
          },
        }]),
    )
    const branchItemsInOrder = (path: 'then' | 'else') => reduceVisibleItems
      .filter(item => item.step?.ifBranch?.if === ifItem.value
        && item.step?.ifBranch?.path === path
        && !item.step?.inLoopGroup)
      .map(item => nestedLoopGroups.get(item.value) || item)

    return {
      ...ifItem,
      clickable: false,
      step: {
        ...ifItem.step,
        nodeKind: 'if_group',
        branches: {
          then: branchItemsInOrder('then'),
          else: branchItemsInOrder('else'),
        },
      },
    }
  })
  const groupedIds = new Set(groupedIfItems.map(item => item.value))
  const groupedByValue = new Map(groupedIfItems.map(item => [item.value, item]))

  const visibleItems = reduceVisibleItems.flatMap(item => {
    const ifGroup = groupedByValue.get(item.value)
    if (ifGroup) return [ifGroup]
    if (branchValues.has(item.value) || groupedIds.has(item.value)) return []
    return [item]
  })

  return [allItem, ...visibleItems, ...lifecycleEventItems.value]
})

// Helper to format timestamps
const formatTime = (timestamp: string | number | Date) => {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0)
    return `${days}d ago`
  if (hours > 0)
    return `${hours}h ago`
  if (minutes > 0)
    return `${minutes}m ago`
  if (seconds > 10)
    return `${seconds}s ago`
  return 'just now'
}

// Helper to calculate duration
const getDuration = (start?: string | number, end?: string | number) => {
  if (!start)
    return '—'
  const startTime = new Date(start).getTime()
  const endTime = end ? new Date(end).getTime() : Date.now()
  const diff = endTime - startTime
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0)
    return `${hours}h ${minutes % 60}m`
  if (minutes > 0)
    return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

// Status color helpers
const getStatusColor = (status?: string) => {
  switch (status) {
    case 'completed': return 'bg-emerald-500'
    case 'failed': return 'bg-red-500'
    case 'running': return 'bg-blue-500 animate-pulse'
    case 'awaiting': return 'bg-purple-500 animate-pulse'
    case 'canceled': return 'bg-orange-500'
    case 'stalled': return 'bg-amber-600'
    default: return 'bg-gray-300'
  }
}

// Format time until stall timeout
const formatStallTimeout = (start?: string | number, timeout?: number) => {
  if (!start || !timeout) return '—'
  const startTime = new Date(start).getTime()
  const stallTime = startTime + timeout
  const remaining = stallTime - Date.now()

  if (remaining <= 0) return 'now'

  const seconds = Math.floor(remaining / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}
</script>
