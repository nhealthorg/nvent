import { describe, expect, it } from 'vitest'

import { normalizeWorkflowInput } from '../../packages/nvent/src/runtime/nitro/utils/workflow/input-spec'
import {
  collectWorkflowPlanSerializationIssues,
  sanitizeWorkflowPlanInputFrom,
  serializeWorkflowDefinitionOrThrow,
} from '../../packages/nvent/src/runtime/nitro/utils/workflow/definition-serialization'

const isWorkflowValueRef = (value: unknown): value is { $ref: string, $path?: string[], $source: 'node' | 'fanout_item' } => {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as any).$ref === 'string'
    && typeof (value as any).$source === 'string',
  )
}

describe('workflow definition serialization helpers', () => {
  it('normalizes array inputs to string refs only', () => {
    const normalized = normalizeWorkflowInput([
      'node:a',
      { $ref: 'node:b', $source: 'node' },
      { nope: true },
    ], [], isWorkflowValueRef)

    expect(normalized).toEqual({ from: ['node:a', 'node:b'] })
  })

  it('sanitizes invalid input.from object values', () => {
    const plan: any = {
      nodes: {
        a: { function: { id: 'a' }, input: { from: 'run_input' }, depends_on: [] },
        b: { function: { id: 'b' }, input: { from: { bad: true } }, depends_on: ['a'] },
      },
      output: { from: 'a' },
    }

    sanitizeWorkflowPlanInputFrom(plan)

    expect(plan.nodes.b.input.from).toBe('node:a')
  })

  it('reports serialization issues for malformed plan shapes', () => {
    const issues = collectWorkflowPlanSerializationIssues({
      nodes: {
        broken: {
          function: { id: { bad: true } },
          input: { from: { nested: true } },
          depends_on: [],
        },
      },
      output: { from: '' },
    })

    expect(issues.map(i => i.path)).toEqual([
      'definition.nodes.broken.function.id',
      'definition.nodes.broken.input.from',
      'definition.output.from',
    ])
  })

  it('reports fanout and depends_on type issues', () => {
    const issues = collectWorkflowPlanSerializationIssues({
      nodes: {
        broken: {
          function: { id: 'ok' },
          input: { from: 'run_input' },
          depends_on: ['ok', { nope: true }],
          fanout: { over: { map: true }, mode: 'invalid-mode' },
        },
      },
      output: { from: 'broken' },
    })

    expect(issues.map(i => i.path)).toEqual([
      'definition.nodes.broken.depends_on',
      'definition.nodes.broken.fanout.over',
      'definition.nodes.broken.fanout.mode',
    ])
  })

  it('serializes a plan after sanitizing from ref-objects', () => {
    const definition = serializeWorkflowDefinitionOrThrow({
      nodes: {
        a: { function: { id: 'a' }, input: { from: 'run_input' }, depends_on: [] },
        b: { function: { id: 'b' }, input: { from: { $ref: 'node:a' } }, depends_on: ['a'] },
      },
      output: { from: 'a' },
    })

    expect((definition as any).nodes.b.input.from).toBe('node:a')
  })
})
