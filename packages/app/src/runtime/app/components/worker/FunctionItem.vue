<template>
  <div class="flex items-center gap-2 px-2 py-1.5 rounded bg-gray-50 dark:bg-gray-800/50 group">
    <UIcon
      name="i-lucide-function-square"
      class="w-3.5 h-3.5 text-gray-400"
    />
    <UBadge
      v-if="parsed.trigger"
      :color="triggerColor(parsed.trigger)"
      variant="subtle"
      size="xs"
      class="shrink-0 font-mono"
    >
      {{ parsed.trigger }}
    </UBadge>

    <span class="text-xs font-mono text-gray-700 dark:text-gray-300 truncate flex-1">
      {{ parsed.path }}
    </span>

    <span
      v-if="parsed.config"
      class="text-[10px] text-gray-400 dark:text-gray-500 font-mono shrink-0 truncate max-w-[150px]"
    >
      {{ parsed.config }}
    </span>

    <UButton
      size="xs"
      variant="ghost"
      color="neutral"
      icon="i-lucide-play"
      class="ml-auto opacity-0 group-hover:opacity-100 transition-opacity"
      :to="`/workflows/new?function_id=${functionId}`"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from '#imports'

const props = defineProps<{
  functionId: string
}>()

interface ParsedFn {
  path: string
  trigger: string | null
  config: string | null
}

const parsed = computed<ParsedFn>(() => {
  const m = props.functionId.match(/^(.+?)::trigger::(\w+)\((.+)\)$/)
  if (m) return { path: m[1]!, trigger: m[2]!, config: m[3]! }
  return { path: props.functionId, trigger: null, config: null }
})

function triggerColor(trigger: string | null): 'info' | 'success' | 'warning' | 'neutral' {
  if (trigger === 'http') return 'info'
  if (trigger === 'queue') return 'success'
  if (trigger === 'cron') return 'warning'
  return 'neutral'
}
</script>
