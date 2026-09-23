<template>
  <div :class="['control-node', `control-node--${kind}`]">
    <div class="control-node__topline">
      <div class="flex items-center gap-2 min-w-0">
        <UIcon :name="icon" class="size-5 shrink-0" />
        <span class="control-node__eyebrow">{{ eyebrow }}</span>
      </div>
      <span :class="['control-node__status', `control-node__status--${statusTone}`]">
        {{ statusLabel }}
      </span>
    </div>

    <div class="control-node__title">{{ title }}</div>

    <template v-if="kind === 'var'">
      <div class="control-node__value">
        <span class="control-node__label">Variable</span>
        <code>{{ variableName }}</code>
      </div>
      <div class="control-node__hint">Run-scoped workflow value</div>
    </template>

    <template v-else-if="kind === 'if'">
      <div class="control-node__condition">
        <span class="control-node__label">Condition</span>
        <code :title="conditionText">{{ conditionText }}</code>
      </div>
      <div class="control-node__decision">
        <span>Selected branch</span>
        <strong>{{ selectedBranch }}</strong>
      </div>
    </template>

    <template v-else>
      <div class="control-node__branch-path">
        <span class="control-node__branch-pill">{{ branchPath }}</span>
        <span>{{ branchSelected ? 'Executed' : 'Skipped' }}</span>
      </div>
      <div class="control-node__hint">Branch of {{ data.ifBranch?.if || '-' }}</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from '#imports'

const props = defineProps<{
  id: string
  data: Record<string, any>
}>()

type ControlKind = 'var' | 'if' | 'if_branch'

const kind = computed<ControlKind>(() => props.data?.nodeKind || 'if')
const data = computed(() => props.data || {})

const icon = computed(() => kind.value === 'var'
  ? 'i-heroicons-variable-20-solid'
  : 'i-lucide-git-branch')

const eyebrow = computed(() => kind.value === 'var' ? 'DATA' : kind.value === 'if' ? 'CONTROL FLOW' : 'BRANCH')
const title = computed(() => {
  if (kind.value === 'var') return 'Workflow variable'
  if (kind.value === 'if') return 'If / Else'
  return `${String(data.value.ifBranch?.path || 'branch').toUpperCase()} branch`
})

const variableName = computed(() => {
  const label = String(data.value.label || '').trim()
  if (label && !label.includes('internal-var-set')) return label
  const id = String(props.id || '').replace(/^step:/, '')
  return id.replace(/^var_/, '') || 'unnamed'
})

function formatOperand(value: unknown): string {
  if (value === undefined) return 'pending'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object' && value) {
    const ref = value as Record<string, any>
    const pathParts = Array.isArray(ref.path) ? ref.path : Array.isArray(ref.$path) ? ref.$path : []
    const path = pathParts.join('.')
    if (path) {
      const sourceValue = ref.source || ref.$source
      const source = sourceValue === 'run_input' ? 'input' : sourceValue === 'fanout_item' ? 'item' : ''
      return source ? `${source}.${path}` : path
    }
    if (typeof ref.value === 'string') return ref.value
    if (typeof ref.$value === 'string') return ref.$value
  }
  return 'value'
}

function formatPredicate(predicate: any): string {
  if (!predicate || typeof predicate !== 'object') return 'condition pending'
  const operators: Record<string, string> = {
    equals: '=',
    not_equals: '!=',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
  }
  if (operators[predicate.op]) {
    return `${formatOperand(predicate.left)} ${operators[predicate.op]} ${formatOperand(predicate.right)}`
  }
  if (predicate.op === 'not') return `NOT (${formatPredicate(predicate.arg)})`
  if (predicate.op === 'and' || predicate.op === 'or') {
    const joiner = predicate.op === 'and' ? ' AND ' : ' OR '
    return (predicate.args || []).map((item: any) => formatPredicate(item)).join(joiner)
  }
  return String(predicate.op || 'condition')
}

const conditionText = computed(() => {
  const predicate = data.value.if?.predicate
  if (predicate) return formatPredicate(predicate)
  return data.value.if?.source ? String(data.value.if.source) : 'condition pending'
})

const selectedBranch = computed(() => data.value.ifSelected ? String(data.value.ifSelected).toUpperCase() : 'PENDING')
const branchPath = computed(() => String(data.value.ifBranch?.path || 'branch').toUpperCase())
const branchSelected = computed(() => data.value.ifBranchSelected !== false)
const statusLabel = computed(() => {
  if (kind.value === 'if_branch' && !branchSelected.value) return 'SKIPPED'
  return String(data.value.status || 'idle').toUpperCase()
})
const statusTone = computed(() => {
  if (kind.value === 'if_branch' && !branchSelected.value) return 'muted'
  if (data.value.status === 'failed' || data.value.error) return 'error'
  if (data.value.status === 'completed' || data.value.status === 'done') return 'done'
  if (data.value.status === 'running') return 'running'
  return 'pending'
})
</script>

<style scoped>
.control-node {
  width: 280px;
  min-height: 142px;
  padding: 16px;
  border: 1px solid;
  border-radius: 14px;
  background: white;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
}

.control-node--var {
  border-color: rgb(192 132 252);
  background: linear-gradient(145deg, rgb(250 245 255), white);
  color: rgb(88 28 135);
}

.control-node--if,
.control-node--if_branch {
  border-color: rgb(56 189 248);
  background: linear-gradient(145deg, rgb(240 249 255), white);
  color: rgb(12 74 110);
}

.control-node__topline,
.control-node__value,
.control-node__condition,
.control-node__decision,
.control-node__branch-path {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.control-node__eyebrow,
.control-node__label,
.control-node__hint {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.68;
}

.control-node__title {
  margin: 16px 0 14px;
  font-size: 18px;
  font-weight: 700;
}

.control-node__value,
.control-node__condition,
.control-node__decision,
.control-node__branch-path {
  padding-top: 9px;
  border-top: 1px solid currentColor;
  border-color: color-mix(in srgb, currentColor 18%, transparent);
  font-size: 12px;
}

.control-node__value code,
.control-node__condition code {
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

.control-node__hint {
  margin-top: 11px;
}

.control-node__decision strong {
  font-size: 12px;
}

.control-node__branch-pill,
.control-node__status {
  padding: 3px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.control-node__branch-pill {
  background: rgb(186 230 253);
}

.control-node__status--done {
  background: rgb(187 247 208);
  color: rgb(22 101 52);
}

.control-node__status--running {
  background: rgb(186 230 253);
  color: rgb(7 89 133);
}

.control-node__status--error {
  background: rgb(254 202 202);
  color: rgb(153 27 27);
}

.control-node__status--muted,
.control-node__status--pending {
  background: rgb(226 232 240);
  color: rgb(71 85 105);
}

:global(.dark) .control-node {
  background: rgb(24 24 27);
}

:global(.dark) .control-node--var {
  background: linear-gradient(145deg, rgb(59 7 100), rgb(24 24 27));
  color: rgb(233 213 255);
}

:global(.dark) .control-node--if,
:global(.dark) .control-node--if_branch {
  background: linear-gradient(145deg, rgb(8 47 73), rgb(24 24 27));
  color: rgb(186 230 253);
}
</style>
