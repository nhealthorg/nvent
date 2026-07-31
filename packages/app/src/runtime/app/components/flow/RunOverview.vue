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

    <div class="px-2 py-2 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-zinc-900 shrink-0">
      <div class="flex items-center gap-2 overflow-x-auto overflow-y-hidden pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div
          v-for="item in overviewFacts"
          :key="item.label"
          class="inline-flex flex-shrink-0 items-center gap-2 rounded-full border border-gray-200 dark:border-gray-700 bg-gray-50/90 dark:bg-zinc-950 px-2.5 py-1 text-xs shadow-sm"
        >
          <UIcon
            :name="item.icon"
            class="w-3.5 h-3.5 flex-shrink-0"
            :class="item.iconClass"
          />
          <span class="text-gray-800 dark:text-gray-100 font-medium whitespace-nowrap">{{ item.value }}</span>
        </div>
      </div>
    </div>

    <!-- Scrollable Steps List -->
    <div class="flex-1 overflow-y-auto overflow-x-hidden px-6 py-6">
      <div
        v-if="steps.length === 0"
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
}>()

const emit = defineEmits<{
  'select-step': [stepKey: string | null]
  'cancel-flow': []
  'restart-flow': []
  'inspect-step-result': [stepKey: string]
}>()

const executableStepCount = computed(() => props.steps.filter(step => !step?.isLoopGroup).length)

const overviewFacts = computed(() => {
  const facts = [
    {
      label: 'steps',
      value: `${executableStepCount.value}`,
      icon: 'i-lucide-layers',
      iconClass: 'text-gray-400',
    },
    {
      label: 'started',
      value: props.startedAt ? formatTime(props.startedAt) : 'Not started',
      icon: 'i-lucide-clock',
      iconClass: 'text-gray-400',
    },
    {
      label: 'duration',
      value: getDuration(props.startedAt, props.completedAt),
      icon: 'i-lucide-timer',
      iconClass: 'text-gray-400',
    },
  ]

  if ((props.loopOverview?.loops || 0) > 0) {
    facts.push({
      label: 'loops',
      value: `${props.loopOverview?.expandedLoops || 0}/${props.loopOverview?.loops || 0} • ${props.loopOverview?.completedItems || 0}/${props.loopOverview?.totalItems || 0} items`,
      icon: 'i-heroicons-arrow-path-rounded-square-20-solid',
      iconClass: 'text-cyan-500',
    })
  }

  if ((props.runStatus === 'running' || props.runStatus === 'awaiting') && props.stallTimeout) {
    facts.push({
      label: 'stall',
      value: formatStallTimeout(props.startedAt, props.stallTimeout),
      icon: 'i-lucide-alert-triangle',
      iconClass: 'text-amber-500',
    })
  }

  return facts
})

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

  return [allItem, ...stepItems]
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
