<template>
  <div @click.stop="$emit('details', workflow)" class="h-full cursor-pointer bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden flex flex-col transition-all hover:shadow-md group">
    <div class="p-6 flex-grow">
      <div class="flex items-start justify-between mb-2">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-lg bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center text-orange-600 dark:text-orange-400">
            <UIcon name="i-lucide-workflow" class="w-5 h-5" />
          </div>
          <div>
            <h3 class="font-bold text-zinc-900 dark:text-white leading-tight break-all">
              {{ workflow.id }}
            </h3>
            <p v-if="workflow.description" class="text-sm text-zinc-500 dark:text-zinc-400 mt-1 line-clamp-2">
              {{ workflow.description }}
            </p>
          </div>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap gap-1.5">
        <span class="px-2 py-0.5 text-[10px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded uppercase tracking-wider">
          Workflow
        </span>
        <span v-if="workflow.triggers?.length" class="px-2 py-0.5 text-[10px] font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded uppercase tracking-wider">
          {{ workflow.triggers.length }} Triggers
        </span>
      </div>
    </div>

    <div class="px-6 py-4 bg-zinc-50 dark:bg-zinc-950 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between opacity-80 group-hover:opacity-100 transition-opacity">
      <div class="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span class="relative flex h-2 w-2">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
        </span>
        <span class="font-medium">Active</span>
      </div>
      <div class="flex items-center gap-2">
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-play"
          label="Trigger"
          @click.stop="$emit('trigger', workflow)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  workflow: {
    id: string
    description?: string
    triggers?: any[]
    filePath?: string
    request_format?: any
  }
}>()

defineEmits(['details', 'trigger'])
</script>
