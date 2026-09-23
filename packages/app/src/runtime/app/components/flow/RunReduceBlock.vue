<template>
  <div class="run-reduce-block">
    <div class="run-reduce-block__header">
      <div class="flex items-center gap-2 min-w-0">
        <UIcon name="i-lucide-repeat-2" class="size-4 text-orange-700 dark:text-orange-300" />
        <div>
          <div class="run-reduce-block__eyebrow">ACCUMULATOR</div>
          <div class="run-reduce-block__title">Reduce</div>
        </div>
      </div>
      <span :class="['run-reduce-block__status', statusClass]">{{ statusLabel }}</span>
    </div>

    <div class="run-reduce-block__meta">
      <span>over</span>
      <code :title="over">{{ over }}</code>
    </div>
    <div class="run-reduce-block__progress">
      <span>Progress</span>
      <strong>{{ progress }}</strong>
    </div>

    <div class="run-reduce-block__body">
      <div class="run-reduce-block__body-label">REDUCE BODY</div>
      <button
        v-for="item in step.bodyItems || []"
        :key="item.value"
        type="button"
        :class="['run-reduce-block__child', { 'run-reduce-block__child--selected': modelValue === item.value }]"
        @click.stop="$emit('select', item.value)"
      >
        <UIcon
          :name="getStepStatusIcon(item.step.status)"
          class="size-3.5 shrink-0"
          :class="getStepStatusIconColor(item.step.status)"
        />
        <span class="truncate">{{ item.label || getStepDisplayName(item.step) }}</span>
        <span class="ml-auto text-[10px]" :class="getStepStatusTextColor(item.step.status)">{{ item.step.status || 'pending' }}</span>
      </button>
      <div v-if="!step.bodyItems?.length" class="run-reduce-block__empty">No reduce body steps</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from '#imports'
import {
  getStepDisplayName,
  getStepStatusIcon,
  getStepStatusIconColor,
  getStepStatusTextColor,
} from './step-selector.utils'

const props = defineProps<{ step: any, modelValue: string }>()
defineEmits<{ select: [value: string] }>()

const checkpoint = computed(() => props.step?.reduceCheckpoint || {})
const over = computed(() => String(props.step?.reduceSpec?.over || 'items'))
const progress = computed(() => {
  const next = Number(checkpoint.value.next_index)
  const total = Number(checkpoint.value.total_items)
  if (Number.isFinite(next) && Number.isFinite(total)) return `${next} / ${total}`
  return 'pending'
})
const statusLabel = computed(() => String(props.step?.status || 'pending').toUpperCase())
const statusClass = computed(() => props.step?.status === 'failed' ? 'run-reduce-block__status--error' : props.step?.status === 'completed' ? 'run-reduce-block__status--done' : '')
</script>

<style scoped>
.run-reduce-block { width: 100%; padding: 8px; border: 1px solid rgb(253 186 116); border-radius: 8px; background: rgb(255 247 237); color: rgb(154 52 18); }
.run-reduce-block__header, .run-reduce-block__meta, .run-reduce-block__progress { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.run-reduce-block__eyebrow { font-size: 10px; letter-spacing: .08em; opacity: .7; }
.run-reduce-block__title { margin-top: 2px; font-size: 13px; font-weight: 700; }
.run-reduce-block__status { padding: 3px 7px; border-radius: 999px; background: rgb(226 232 240); color: rgb(71 85 105); font-size: 10px; font-weight: 700; letter-spacing: .05em; }
.run-reduce-block__status--done { background: rgb(187 247 208); color: rgb(22 101 52); }
.run-reduce-block__status--error { background: rgb(254 202 202); color: rgb(153 27 27); }
.run-reduce-block__meta, .run-reduce-block__progress { margin-top: 7px; padding-top: 6px; border-top: 1px solid rgb(194 65 12 / .18); font-size: 10px; }
.run-reduce-block__meta code { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.run-reduce-block__body { margin-top: 8px; padding: 5px; border: 1px solid rgb(253 186 116 / .8); border-radius: 6px; background: rgb(255 255 255 / .55); }
.run-reduce-block__body-label { margin-bottom: 5px; font-size: 9px; font-weight: 800; letter-spacing: .08em; }
.run-reduce-block__child { display: flex; align-items: center; gap: 5px; width: 100%; min-width: 0; padding: 5px 6px; border: 1px solid rgb(254 215 170); border-radius: 5px; background: rgb(255 255 255 / .72); text-align: left; font-size: 10px; color: rgb(124 45 18); }
.run-reduce-block__child:hover, .run-reduce-block__child--selected { border-color: rgb(249 115 22); background: rgb(255 237 213); }
.run-reduce-block__empty { font-size: 10px; font-style: italic; opacity: .65; }
:global(.dark) .run-reduce-block { background: rgb(67 20 7 / .4); color: rgb(254 215 170); }
:global(.dark) .run-reduce-block__body, :global(.dark) .run-reduce-block__child { background: rgb(67 20 7 / .35); }
</style>
