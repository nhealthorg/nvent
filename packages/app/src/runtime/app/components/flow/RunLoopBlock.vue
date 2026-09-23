<template>
  <div class="run-loop-block">
    <div class="run-loop-block__header">
      <div class="flex items-center gap-2 min-w-0">
        <UIcon name="i-heroicons-arrow-path-rounded-square-20-solid" class="size-4 text-cyan-700 dark:text-cyan-300" />
        <div class="min-w-0">
          <div class="run-loop-block__eyebrow">LOOP</div>
          <div class="run-loop-block__title">{{ step.loopGroupId || 'Loop' }}</div>
        </div>
      </div>
      <span class="run-loop-block__status">{{ String(step.status || 'pending').toUpperCase() }}</span>
    </div>
    <div v-if="step.loopOver" class="run-loop-block__meta">
      <span>over</span>
      <code :title="step.loopOver">{{ step.loopOver }}</code>
    </div>
    <div class="run-loop-block__stats">
      <span>Items</span>
      <strong>{{ step.loopItemsDone || 0 }}/{{ step.loopItemsTotal || 0 }}</strong>
      <UBadge size="xs" color="info" variant="outline">{{ step.loopMode || 'parallel' }}</UBadge>
    </div>
    <div class="run-loop-block__children">
      <div class="run-loop-block__body-label">LOOP BODY</div>
      <button
        v-for="child in children"
        :key="child.value"
        type="button"
        :class="['run-loop-block__child', { 'run-loop-block__child--selected': modelValue === child.value }]"
        @click.stop="$emit('select', child.value)"
      >
        <UIcon name="i-lucide-circle" class="size-3 shrink-0 text-cyan-500" />
        <span class="truncate">{{ child.label || getStepDisplayName(child.step) }}</span>
        <span class="ml-auto text-[10px]">{{ child.step.status || 'pending' }}</span>
      </button>
      <div v-if="children.length === 0" class="run-loop-block__empty">No loop body steps</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from '#imports'
import { getStepDisplayName } from './step-selector.utils'

const props = defineProps<{ step: any, modelValue: string }>()
defineEmits<{ select: [value: string] }>()
const children = computed(() => props.step?.loopChildren || [])
</script>

<style scoped>
.run-loop-block { width: 100%; padding: 7px; border: 1px solid rgb(103 232 249 / .8); border-radius: 7px; background: rgb(236 254 255 / .72); color: rgb(14 116 144); }
.run-loop-block__header, .run-loop-block__meta, .run-loop-block__stats { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.run-loop-block__eyebrow, .run-loop-block__body-label { font-size: 9px; letter-spacing: .08em; opacity: .7; }
.run-loop-block__title { margin-top: 2px; font-size: 12px; font-weight: 700; }
.run-loop-block__status { padding: 2px 5px; border-radius: 999px; background: rgb(207 250 254); font-size: 9px; font-weight: 700; }
.run-loop-block__meta, .run-loop-block__stats { margin-top: 7px; padding-top: 6px; border-top: 1px solid rgb(8 145 178 / .16); font-size: 10px; }
.run-loop-block__meta code { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-loop-block__children { margin-top: 6px; padding: 5px; border: 1px solid rgb(103 232 249 / .65); border-radius: 6px; background: rgb(255 255 255 / .55); }
.run-loop-block__body-label { margin-bottom: 5px; font-weight: 700; }
.run-loop-block__child { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px; border: 1px solid rgb(165 243 252); border-radius: 5px; background: rgb(255 255 255 / .72); text-align: left; font-size: 10px; }
.run-loop-block__child + .run-loop-block__child { margin-top: 4px; }
.run-loop-block__child:hover, .run-loop-block__child--selected { background: rgb(207 250 254); border-color: rgb(6 182 212); }
.run-loop-block__empty { font-size: 10px; font-style: italic; opacity: .65; }
:global(.dark) .run-loop-block { background: rgb(8 47 73 / .4); color: rgb(165 243 252); }
</style>
