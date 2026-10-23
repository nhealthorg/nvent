// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import StepSelector from '../src/runtime/app/components/flow/StepSelector.vue'
import RunOverview from '../src/runtime/app/components/flow/RunOverview.vue'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function mount(component: any, props: () => Record<string, any>) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(defineComponent({ setup: () => () => h(component, props()) }))
  app.component('UIcon', defineComponent({ setup: () => () => h('span') }))
  app.component('UBadge', defineComponent({ setup: (_, { slots }) => () => h('span', slots.default?.()) }))
  app.component('UPopover', defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }))
  app.component('UButton', defineComponent({ props: ['label'], setup: (props, { slots }) => () => h('button', props.label || slots.default?.()) }))
  app.mount(host)
  cleanups.push(() => { app.unmount(); host.remove() })
  return host
}

const item = (value: string, step: Record<string, any> = {}) => ({ value, label: value, step: { key: value, label: value, ...step } })
const fixture = () => [
  item('outer', { ifSpec: {}, ifSelected: 'then' }),
  item('reduce-group:sum', { nodeKind: 'reduce_group', reduceId: 'sum', reduceSpec: { body: ['inner', 'leaf'] }, ifBranch: { if: 'outer', path: 'then' } }),
  item('inner', { ifSpec: {}, reduceBody: { reduce: 'sum' }, ifDecisions: [{ uid: 'inner#0', checkpoint: { selected: 'then' } }, { uid: 'inner#1', checkpoint: { selected: 'else' } }] }),
  item('leaf', { reduceBody: { reduce: 'sum' }, ifBranch: { if: 'inner', path: 'then' }, canInspectResult: true }),
]

describe('recursive run outline UI', () => {
  it('renders deep controls and iteration decisions, retains selection and collapse on refreshed items, forwards result events', async () => {
    const items = ref(fixture())
    const selected = ref('all-steps')
    const results: string[] = []
    const host = mount(StepSelector, () => ({ items: items.value, modelValue: selected.value,
      'onUpdate:modelValue': (value: string) => { selected.value = value },
      onInspectStepResult: (value: string) => results.push(value),
    }))
    expect(host.textContent).toContain('#0: THEN')
    expect(host.textContent).toContain('#1: ELSE')
    const leaf = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('leaf'))!
    leaf.click()
    await nextTick()
    expect(selected.value).toBe('leaf')
    const result = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Result')!
    result.click()
    expect(results).toEqual(['leaf'])
    const collapse = host.querySelector<HTMLButtonElement>('[aria-label="Collapse outer"]')!
    collapse.click()
    await nextTick()
    expect(collapse.getAttribute('aria-expanded')).toBe('false')
    items.value = fixture()
    await nextTick()
    expect(collapse.getAttribute('aria-expanded')).toBe('false')
    expect(selected.value).toBe('leaf')
    collapse.click()
    await nextTick()
    expect(host.textContent).toContain('leaf')
    expect(host.querySelector('[aria-pressed="true"]')).not.toBeNull()
  })

  it('forwards nested child-run events and marks descendants of skipped branches', () => {
    const runs: unknown[] = []
    const host = mount(StepSelector, () => ({
      modelValue: 'all-steps',
      items: [item('if', { ifSpec: {}, ifSelected: 'else' }), item('child', { nodeKind: 'if_branch', ifBranch: { if: 'if', path: 'then' }, childRunId: 'run-1' })],
      onOpenChildRun: (value: unknown) => runs.push(value),
    }))
    const open = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Open child run')
    expect(host.textContent).toContain('skipped')
    expect(open).toBeDefined()
    open!.click()
    expect(runs).toEqual([{ runId: 'run-1' }])
  })

  it('keeps parent selection across polling and clears it only on a run change', async () => {
    const steps = ref(fixture().map(item => item.step))
    const runId = ref('run-1')
    const selection = ref<string | null>('leaf')
    const host = mount(RunOverview, () => ({ steps: steps.value, runId: runId.value, selectedStepKey: selection.value,
      'onSelect-step': (value: string | null) => { selection.value = value },
    }))
    steps.value = [item('earlier').step, ...fixture().map(item => item.step)]
    await nextTick()
    expect(selection.value).toBe('leaf')
    expect(host.querySelector('[aria-pressed="true"]')).not.toBeNull()
    runId.value = 'run-2'
    await nextTick()
    await nextTick()
    expect(selection.value).toBeNull()
  })

  it('forwards loop bulk child-run inspection through a nested if', () => {
    const childRuns = Array.from({ length: 7 }, (_, index) => ({ index, runId: `run-${index}`, status: 'completed' }))
    const received: unknown[] = []
    const host = mount(StepSelector, () => ({ modelValue: 'all-steps',
      items: [item('if', { ifSpec: {}, ifSelected: 'then' }), item('loop', { isLoopGroup: true, loopGroupId: 'loop', ifBranch: { if: 'if', path: 'then' }, childRuns })],
      onViewChildRuns: (value: unknown) => received.push(value),
    }))
    const view = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Child runs (7)')!
    view.click()
    expect(received).toEqual([childRuns])
  })
})