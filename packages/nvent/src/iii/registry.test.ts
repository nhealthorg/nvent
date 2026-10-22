import { describe, expect, it } from 'vitest'
import { generateIiiRegistryTemplate } from './registry'

const noWorkflows = { functions: [], pythonFunctions: [], workflows: [] }

describe('workflow registry entries', () => {
  it('wraps workflow input with its registered ID before invocation', () => {
    const registry = generateIiiRegistryTemplate({
      ...noWorkflows,
      workflows: [{
        id: 'cohort::extract',
        absPath: '/app/server/workflows/cohort/extract.ts',
        relativePath: 'cohort/extract.ts',
        runtime: 'nodejs',
      }],
    })

    expect(registry).toContain("fn.$workflow ? (input, context) => fn.handler({ _nventRegisteredWorkflow: { id, input } }, context) : fn.handler")
    expect(registry).toContain("_entry(wf0, \"cohort::extract\"")
  })
})
