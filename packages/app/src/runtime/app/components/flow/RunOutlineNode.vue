<template>
  <div class="min-w-0" :class="node.skipped ? 'opacity-60' : ''">
    <StepSelector
      v-if="node.kind === 'step'"
      :items="[leafItem]"
      :model-value="modelValue"
      @update:model-value="emit('select', $event)"
      @inspect-step-result="emit('inspect-step-result', $event)"
      @open-child-run="emit('open-child-run', $event)"
      @view-child-runs="emit('view-child-runs', $event)"
    />
    <template v-else>
      <div class="flex min-w-0 items-center gap-1 py-1">
        <button
          type="button"
          class="flex size-7 shrink-0 items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-800"
          :aria-expanded="expanded"
          :aria-label="`${expanded ? 'Collapse' : 'Expand'} ${title}`"
          :title="`${expanded ? 'Collapse' : 'Expand'} ${title}`"
          @click="expanded = !expanded"
        >
          <UIcon :name="expanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4" />
        </button>
        <button
          type="button"
          class="min-w-0 flex-1 rounded px-1 py-1 text-left text-xs font-semibold break-words"
          :class="containsSelection ? 'bg-primary/10 text-primary' : 'text-gray-700 dark:text-gray-200'"
          :aria-pressed="modelValue === node.item.value"
          @click="emit('select', node.item.value)"
        >{{ title }}</button>
        <span v-if="node.skipped" class="shrink-0 text-[10px] text-gray-500">Skipped</span>
        <UButton
          v-if="node.item.step.canInspectResult"
          icon="i-lucide-file-json"
          color="neutral"
          variant="ghost"
          size="xs"
          title="Inspect result"
          aria-label="Inspect result"
          @click="emit('inspect-step-result', node.item.value)"
        />
      </div>
      <component
        :is="blockComponent"
        v-show="expanded"
        :step="node.item.step"
        :model-value="modelValue"
      >
        <div class="mt-2 space-y-2">
          <section v-for="branch in node.branches" :key="branch.path" class="border-l-2 pl-2" :class="branch.selected === false || node.skipped ? 'border-dashed border-gray-300 dark:border-gray-700' : 'border-sky-400'">
            <div class="flex flex-wrap items-center gap-2 py-1 text-[10px] font-semibold">
              <span>{{ branch.path.toUpperCase() }}</span>
              <span>{{ node.skipped || branch.selected === false ? 'Skipped' : branch.selected === true ? 'Selected' : node.item.step.ifDecisions?.some((decision: any) => decision.uid.includes('#')) ? 'Per iteration' : 'Pending' }}</span>
            </div>
            <RunOutlineNode
              v-for="child in branch.children"
              :key="child.item.value"
              :node="child"
              :model-value="modelValue"
              @select="emit('select', $event)"
              @inspect-step-result="emit('inspect-step-result', $event)"
              @open-child-run="emit('open-child-run', $event)"
              @view-child-runs="emit('view-child-runs', $event)"
            />
            <div v-if="!branch.children.length" class="py-1 text-[10px] opacity-60">No branch steps</div>
          </section>
          <RunOutlineNode
            v-for="child in node.children"
            :key="child.item.value"
            :node="child"
            :model-value="modelValue"
            @select="emit('select', $event)"
            @inspect-step-result="emit('inspect-step-result', $event)"
            @open-child-run="emit('open-child-run', $event)"
            @view-child-runs="emit('view-child-runs', $event)"
          />
          <div v-if="!node.branches.length && !node.children.length" class="text-[10px] opacity-60">No body steps</div>
        </div>
        <div v-if="node.item.step.childRuns?.length" class="mt-2 flex flex-wrap items-center gap-1">
          <template v-if="node.item.step.childRuns.length <= 6">
            <button
              v-for="run in node.item.step.childRuns"
              :key="run.runId"
              type="button"
              class="inline-flex items-center gap-1 rounded border border-cyan-300 px-1.5 py-1 text-[10px] dark:border-cyan-800"
              :title="run.runId"
              :aria-label="`Open child run #${run.index}`"
              @click="emit('open-child-run', { runId: run.runId })"
            >
              <span>#{{ run.index }}</span>
              <UIcon name="i-lucide-external-link" class="size-3" />
            </button>
          </template>
          <UButton
            v-else
            icon="i-lucide-list"
            size="xs"
            variant="ghost"
            color="neutral"
            :label="`Child runs (${node.item.step.childRuns.length})`"
            @click="emit('view-child-runs', node.item.step.childRuns)"
          />
        </div>
      </component>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { OutlineNode } from './run-outline'
import StepSelector from './StepSelector.vue'
import RunIfBlock from './RunIfBlock.vue'
import RunReduceBlock from './RunReduceBlock.vue'
import RunLoopBlock from './RunLoopBlock.vue'

const props = defineProps<{ node: OutlineNode, modelValue: string }>()
const emit = defineEmits<{
  select: [value: string]
  'inspect-step-result': [value: string]
  'open-child-run': [payload: { runId: string }]
  'view-child-runs': [runs: Array<{ index: number, runId: string, status: string }>]
}>()
const expanded = ref(true)
const title = computed(() => props.node.item.step.label || `${props.node.kind === 'if' ? 'If / Else' : props.node.kind === 'reduce' ? 'Reduce' : 'Loop'}: ${props.node.item.value}`)
const blockComponent = computed(() => props.node.kind === 'if' ? RunIfBlock : props.node.kind === 'reduce' ? RunReduceBlock : RunLoopBlock)
const leafItem = computed(() => ({ ...props.node.item, step: { ...props.node.item.step, status: props.node.skipped ? 'skipped' : props.node.item.step.status } }))
const containsSelection = computed(() => {
  const contains = (node: OutlineNode): boolean => node.item.value === props.modelValue
    || node.children.some(contains) || node.branches.some(branch => branch.children.some(contains))
  return contains(props.node)
})
</script>