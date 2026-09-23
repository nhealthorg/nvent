<template>
  <div :class="['run-control', `run-control--${kind}`, { 'run-control--skipped': kind === 'if_branch' && !branchSelected }]">
    <div class="run-control__header">
      <div class="flex items-center gap-2 min-w-0">
        <UIcon :name="icon" class="size-4 shrink-0" />
        <span class="run-control__eyebrow">{{ eyebrow }}</span>
      </div>
      <span :class="['run-control__status', `run-control__status--${statusTone}`]">{{ statusLabel }}</span>
    </div>

    <div class="run-control__title">{{ title }}</div>

    <template v-if="kind === 'var'">
      <div class="run-control__row">
        <span>Variable</span>
        <code>{{ variableName }}</code>
      </div>
      <div class="run-control__hint">Run-scoped workflow value</div>
    </template>

    <template v-else-if="kind === 'if'">
      <div class="run-control__row">
        <span>Condition</span>
        <code :title="conditionText">{{ conditionText }}</code>
      </div>
      <div class="run-control__decision">
        <span>Selected branch</span>
        <strong>{{ selectedBranch }}</strong>
      </div>
    </template>

    <template v-else>
      <div class="run-control__branch">
        <span class="run-control__branch-label">{{ branchPath }}</span>
        <span>{{ branchSelected ? 'Executed' : 'Skipped' }}</span>
      </div>
      <div class="run-control__hint">Branch of {{ step.ifBranch?.if || '-' }}</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from '#imports'

const props = defineProps<{ step: Record<string, any> }>()

type ControlKind = 'var' | 'if' | 'if_branch'
const step = computed(() => props.step || {})
const kind = computed<ControlKind>(() => step.value.nodeKind || 'if')

const icon = computed(() => kind.value === 'var' ? 'i-heroicons-variable-20-solid' : 'i-lucide-git-branch')
const eyebrow = computed(() => kind.value === 'var' ? 'DATA' : kind.value === 'if' ? 'CONTROL FLOW' : 'BRANCH')
const title = computed(() => {
  if (kind.value === 'var') return 'Workflow variable'
  if (kind.value === 'if') return 'If / Else'
  return `${String(step.value.ifBranch?.path || 'branch').toUpperCase()} branch`
})
const variableName = computed(() => {
  const label = String(step.value.label || '').trim()
  if (label.startsWith('var:')) return label.slice(4).trim()
  return String(step.value.key || 'unnamed').replace(/^var_/, '')
})

function operand(value: any): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value && typeof value === 'object') {
    const path = Array.isArray(value.$path) ? value.$path : Array.isArray(value.path) ? value.path : []
    if (path.length) return path.join('.')
  }
  return 'value'
}

function predicate(value: any): string {
  if (!value) return 'condition pending'
  const operators: Record<string, string> = { equals: '=', not_equals: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }
  if (operators[value.op]) return `${operand(value.left)} ${operators[value.op]} ${operand(value.right)}`
  if (value.op === 'not') return `NOT (${predicate(value.arg)})`
  if (value.op === 'and' || value.op === 'or') return (value.args || []).map((item: any) => predicate(item)).join(value.op === 'and' ? ' AND ' : ' OR ')
  return String(value.op || 'condition')
}

const conditionText = computed(() => predicate(step.value.if?.predicate))
const selectedBranch = computed(() => String(step.value.ifSelected || 'pending').toUpperCase())
const branchPath = computed(() => String(step.value.ifBranch?.path || 'branch').toUpperCase())
const branchSelected = computed(() => step.value.ifBranchSelected !== false)
const statusLabel = computed(() => {
  if (kind.value === 'if_branch' && !branchSelected.value) return 'SKIPPED'
  return String(step.value.status || 'pending').toUpperCase()
})
const statusTone = computed(() => {
  if (kind.value === 'if_branch' && !branchSelected.value) return 'muted'
  if (step.value.status === 'failed' || step.value.error) return 'error'
  if (step.value.status === 'completed') return 'done'
  if (step.value.status === 'running') return 'running'
  return 'pending'
})
</script>

<style scoped>
.run-control {
  width: 100%;
  min-height: 0;
  padding: 8px 9px;
  border: 1px solid;
  border-radius: 12px;
}
.run-control--var { min-height: 0; padding: 5px 6px; border-color: rgb(221 214 254); border-left-width: 2px; background: transparent; color: rgb(109 40 217); }
.run-control--if, .run-control--if_branch { border-color: rgb(125 211 252); background: rgb(240 249 255); color: rgb(7 89 133); }
.run-control--if_branch { margin-left: 16px; width: calc(100% - 16px); border-left-width: 4px; }
.run-control--skipped { opacity: .7; border-style: dashed; }
.run-control__header, .run-control__row, .run-control__decision, .run-control__branch { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.run-control__eyebrow, .run-control__hint { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; opacity: .7; }
.run-control__title { margin: 8px 0 7px; font-size: 14px; font-weight: 700; }
.run-control--var .run-control__title { margin: 2px 0 4px; font-size: 11px; font-weight: 600; }
.run-control__row, .run-control__decision, .run-control__branch { padding-top: 6px; border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent); font-size: 11px; }
.run-control--var .run-control__row { padding-top: 3px; border-top: 0; font-size: 10px; }
.run-control__row code { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.run-control__hint { margin-top: 6px; }
.run-control--var .run-control__hint { display: none; }
.run-control__branch-label, .run-control__status { padding: 3px 7px; border-radius: 999px; font-size: 10px; font-weight: 700; letter-spacing: .05em; }
.run-control__branch-label { background: rgb(186 230 253); }
.run-control__status--done { background: rgb(187 247 208); color: rgb(22 101 52); }
.run-control__status--running { background: rgb(186 230 253); color: rgb(7 89 133); }
.run-control__status--error { background: rgb(254 202 202); color: rgb(153 27 27); }
.run-control__status--muted, .run-control__status--pending { background: rgb(226 232 240); color: rgb(71 85 105); }
:global(.dark) .run-control--var { background: rgb(59 7 100 / .35); color: rgb(233 213 255); }
:global(.dark) .run-control--if, :global(.dark) .run-control--if_branch { background: rgb(8 47 73 / .4); color: rgb(186 230 253); }
</style>
