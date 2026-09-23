<template>
  <div class="run-if-block">
    <div class="run-if-block__header">
      <div class="flex items-center gap-2 min-w-0">
        <UIcon name="i-lucide-git-branch" class="size-4 text-sky-700 dark:text-sky-300" />
        <div class="min-w-0">
          <div class="run-if-block__eyebrow">CONTROL FLOW</div>
          <div class="run-if-block__title">If / Else</div>
        </div>
      </div>
      <span :class="['run-if-block__status', statusClass]">{{ statusLabel }}</span>
    </div>

    <div class="run-if-block__condition">
      <span>Condition</span>
      <code :title="conditionText">{{ conditionText }}</code>
    </div>

    <div class="run-if-block__decision">
      <span>Selected branch</span>
      <strong>{{ selectedBranch }}</strong>
    </div>

    <div class="run-if-block__branches">
      <section
        v-for="branch in branches"
        :key="branch.path"
        :class="['run-if-block__branch', { 'run-if-block__branch--skipped': branch.selected === false }]"
      >
        <div class="run-if-block__branch-header">
          <div class="flex items-center gap-2">
            <span :class="['run-if-block__rail', branch.selected === false ? 'bg-slate-300' : 'bg-emerald-500']" />
            <span class="run-if-block__branch-label">{{ branch.path.toUpperCase() }}</span>
            <span v-if="branch.selected === false" class="run-if-block__skipped">Skipped</span>
            <span v-else-if="branch.selected === true" class="run-if-block__executed">Executed</span>
            <span v-else class="run-if-block__skipped">Pending</span>
          </div>
          <span class="text-[10px] text-slate-400">{{ branch.items.length }} step{{ branch.items.length === 1 ? '' : 's' }}</span>
        </div>

        <div class="run-if-block__children">
          <template v-for="item in branch.items" :key="item.value">
            <RunLoopBlock
              v-if="item.step?.isLoopGroup"
              :step="item.step"
              :model-value="modelValue"
              @select="$emit('select', $event)"
            />
            <RunReduceBlock
              v-else-if="item.step?.nodeKind === 'reduce_group'"
              :step="item.step"
              :model-value="modelValue"
              @select="$emit('select', $event)"
            />
            <button
              v-else
              type="button"
              :class="['run-if-block__child', { 'run-if-block__child--selected': modelValue === item.value }]"
              @click.stop="$emit('select', item.value)"
            >
              <UIcon
                :name="getStepStatusIcon(item.step.status)"
                class="size-3.5 shrink-0"
                :class="getStepStatusIconColor(item.step.status)"
              />
              <span class="truncate">{{ item.label || getStepDisplayName(item.step) }}</span>
              <span class="ml-auto shrink-0 text-[10px]" :class="getStepStatusTextColor(item.step.status)">
                {{ item.step.ifBranchSelected === false ? 'skipped' : item.step.status || 'pending' }}
              </span>
            </button>
          </template>
          <div v-if="branch.items.length === 0" class="run-if-block__empty">No branch steps</div>
        </div>
      </section>
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
import RunLoopBlock from './RunLoopBlock.vue'
import RunReduceBlock from './RunReduceBlock.vue'

const props = defineProps<{ step: any, modelValue: string }>()
defineEmits<{ select: [value: string] }>()

const conditionText = computed(() => {
  const predicate = props.step?.ifSpec?.predicate
  if (!predicate) return 'condition pending'
  const operand = (value: any): string => {
    if (value === null) return 'null'
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
    const path = value?.$path || value?.path
    return Array.isArray(path) ? path.join('.') : 'value'
  }
  const format = (value: any): string => {
    if (value?.op === 'not') return `NOT (${format(value.arg)})`
    if (value?.op === 'and' || value?.op === 'or') return (value.args || []).map((item: any) => format(item)).join(value.op === 'and' ? ' AND ' : ' OR ')
    const operators: Record<string, string> = { equals: '=', not_equals: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }
    return operators[value?.op] ? `${operand(value.left)} ${operators[value.op]} ${operand(value.right)}` : String(value?.op || 'condition')
  }
  return format(predicate)
})

const selectedBranch = computed(() => String(props.step?.ifSelected || 'pending').toUpperCase())
const statusLabel = computed(() => String(props.step?.status || 'pending').toUpperCase())
const statusClass = computed(() => props.step?.status === 'failed' ? 'run-if-block__status--error' : props.step?.ifSelected ? 'run-if-block__status--done' : '')
const branches = computed(() => ['then', 'else'].map(path => ({
  path,
  selected: props.step?.ifSelected ? props.step.ifSelected === path : undefined,
  items: props.step?.branches?.[path] || [],
})))
</script>

<style scoped>
.run-if-block { width: 100%; padding: 8px; border: 1px solid rgb(125 211 252); border-radius: 9px; background: rgb(240 249 255); color: rgb(7 89 133); }
.run-if-block__header, .run-if-block__condition, .run-if-block__decision, .run-if-block__branch-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.run-if-block__eyebrow { font-size: 10px; letter-spacing: .08em; opacity: .7; }
.run-if-block__title { margin-top: 2px; font-size: 13px; font-weight: 700; }
.run-if-block__status, .run-if-block__executed, .run-if-block__skipped { padding: 3px 7px; border-radius: 999px; font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
.run-if-block__status { background: rgb(226 232 240); color: rgb(71 85 105); }
.run-if-block__status--done, .run-if-block__executed { background: rgb(187 247 208); color: rgb(22 101 52); }
.run-if-block__status--error { background: rgb(254 202 202); color: rgb(153 27 27); }
.run-if-block__condition, .run-if-block__decision { margin-top: 7px; padding-top: 6px; border-top: 1px solid rgb(14 116 144 / .18); font-size: 10px; }
.run-if-block__condition code { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.run-if-block__decision strong { font-size: 11px; }
.run-if-block__branches { display: grid; gap: 6px; margin-top: 8px; padding-left: 4px; }
.run-if-block__branch { padding: 5px 0 5px 9px; border-left: 2px solid rgb(52 211 153 / .95); }
.run-if-block__branch--skipped { border-left-style: dashed; border-left-color: rgb(148 163 184 / .85); opacity: .68; }
.run-if-block__rail { width: 3px; align-self: stretch; border-radius: 2px; }
.run-if-block__branch-label { font-size: 11px; font-weight: 800; letter-spacing: .08em; }
.run-if-block__skipped { background: rgb(226 232 240); color: rgb(71 85 105); }
.run-if-block__children { display: grid; gap: 3px; margin-top: 5px; padding-left: 7px; }
.run-if-block__child { display: flex; align-items: center; gap: 5px; width: 100%; min-width: 0; padding: 5px 6px; border: 1px solid rgb(186 230 253 / .9); border-radius: 5px; background: rgb(255 255 255 / .72); text-align: left; font-size: 10px; color: rgb(12 74 110); }
.run-if-block__child:hover, .run-if-block__child--selected { border-color: rgb(14 165 233); background: rgb(224 242 254); }
.run-if-block__empty { padding: 5px; font-size: 10px; font-style: italic; opacity: .65; }
:global(.dark) .run-if-block { background: rgb(8 47 73 / .4); color: rgb(186 230 253); }
:global(.dark) .run-if-block__child { background: rgb(8 47 73 / .35); }
</style>
