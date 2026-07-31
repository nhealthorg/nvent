export type WorkflowValueRefLike = {
  $ref: string
  $path?: string[]
  $source: 'node' | 'fanout_item'
}

export type IsWorkflowValueRef = (value: unknown) => value is WorkflowValueRefLike

export type NormalizedInputSpec = {
  from: string | string[]
  template?: string
  value?: unknown
}

type InputSpecLike = {
  from: string | string[]
  template?: string
  value?: unknown
}

function isValidInputFrom(value: unknown): value is string | string[] {
  if (typeof value === 'string') return true
  if (Array.isArray(value)) return value.every(item => typeof item === 'string')
  return false
}

function isInputSpecLike(value: unknown): value is InputSpecLike {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!('from' in record)) return false
  return isValidInputFrom(record.from)
}

export function normalizeWorkflowInput(
  input: any,
  deps: string[],
  isWorkflowValueRef: IsWorkflowValueRef,
): NormalizedInputSpec {
  const containsDynamicRefs = (value: any): boolean => {
    if (isWorkflowValueRef(value)) return true
    if (!value || typeof value !== 'object') return false
    if (Array.isArray(value)) return value.some(containsDynamicRefs)
    return Object.values(value).some(containsDynamicRefs)
  }

  const containsFanoutRefs = (value: any): boolean => {
    if (isWorkflowValueRef(value)) {
      return value.$source === 'fanout_item'
    }
    if (!value || typeof value !== 'object') return false
    if (Array.isArray(value)) return value.some(containsFanoutRefs)
    return Object.values(value).some(containsFanoutRefs)
  }

  const encodeDynamicValue = (value: any): any => {
    if (isWorkflowValueRef(value)) {
      return {
        $wf_ref: value.$source === 'fanout_item' ? 'fanout_item' : value.$ref,
        $wf_path: Array.isArray(value.$path) ? value.$path : [],
      }
    }
    if (Array.isArray(value)) {
      return value.map(encodeDynamicValue)
    }
    if (value && typeof value === 'object') {
      const out: Record<string, any> = {}
      for (const [key, nested] of Object.entries(value)) {
        out[key] = encodeDynamicValue(nested)
      }
      return out
    }
    return value
  }

  const inferDynamicFrom = (value: any): string => {
    if (deps.length === 1) return `node:${deps[0]}`
    return 'run_input'
  }

  if (typeof input === 'string') {
    return { from: input }
  }

  if (Array.isArray(input)) {
    const mappedRefs = input
      .map((item) => {
        if (typeof item === 'string') return item
        if (isWorkflowValueRef(item)) return item.$ref
        if (item && typeof item === 'object' && '$ref' in item && typeof (item as any).$ref === 'string') {
          return (item as any).$ref
        }
        return null
      })
      .filter((item): item is string => typeof item === 'string' && item.length > 0)

    if (mappedRefs.length === 0) {
      return { from: 'run_input' }
    }

    return { from: mappedRefs }
  }

  if (isInputSpecLike(input)) {
    return input
  }

  if (isWorkflowValueRef(input) && input.$source === 'node' && (!input.$path || input.$path.length === 0)) {
    return { from: input.$ref }
  }

  if (isWorkflowValueRef(input)) {
    return {
      // Keep value-template refs active for fanout fields (loop.item.foo):
      // `from: fanout_item` would be short-circuited by the worker to the raw
      // item and skip the `value` projection.
      from: input.$source === 'fanout_item' ? 'run_input' : inferDynamicFrom(input),
      value: encodeDynamicValue(input),
    }
  }

  if (!input) {
    if (deps.length === 1) {
      return { from: `node:${deps[0]}` }
    }
    return { from: 'run_input' }
  }

  if (typeof input === 'object' && !Array.isArray(input) && containsDynamicRefs(input)) {
    return {
      from: inferDynamicFrom(input),
      value: encodeDynamicValue(input),
    }
  }

  if (typeof input === 'object' && !Array.isArray(input)) {
    return { from: 'run_input' }
  }

  return { from: 'run_input' }
}