type WorkflowPlanLike = {
  nodes?: Record<string, any>
  output?: { from?: unknown }
  metadata?: unknown
}

type PlanIssue = {
  path: string
  message: string
  value: unknown
}

function toFallbackFrom(node: any): string {
  const deps = Array.isArray(node?.depends_on)
    ? node.depends_on.filter((dep: unknown) => typeof dep === 'string')
    : []
  if (deps.length === 1) return `node:${deps[0]}`
  return 'run_input'
}

function toStringFromArray(from: unknown[]): string[] {
  const mapped = from
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && '$ref' in item && typeof (item as any).$ref === 'string') {
        return (item as any).$ref
      }
      return null
    })
    .filter((item): item is string => typeof item === 'string' && item.length > 0)

  return mapped.length > 0 ? mapped : ['run_input']
}

export function sanitizeWorkflowPlanInputFrom(plan: WorkflowPlanLike) {
  const nodes = plan?.nodes
  if (!nodes || typeof nodes !== 'object') return

  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!node || typeof node !== 'object') continue

    const input = (node as any).input
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue

    const from = (input as any).from
    if (typeof from === 'string') continue
    if (Array.isArray(from) && from.every(item => typeof item === 'string')) continue

    if (Array.isArray(from)) {
      ;(input as any).from = toStringFromArray(from)
      continue
    }

    if (from && typeof from === 'object' && '$ref' in from && typeof (from as any).$ref === 'string') {
      ;(input as any).from = (from as any).$ref
      continue
    }

    const fallbackFrom = toFallbackFrom(node)
    ;(input as any).from = fallbackFrom
    console.warn(`[nvent/workflow] Sanitized invalid input.from for node '${nodeId}' to '${fallbackFrom}'.`)
  }
}

export function collectWorkflowPlanSerializationIssues(plan: WorkflowPlanLike): PlanIssue[] {
  const issues: PlanIssue[] = []
  const nodes = plan?.nodes

  if (!nodes || typeof nodes !== 'object') {
    issues.push({
      path: 'definition.nodes',
      message: 'nodes must be an object',
      value: nodes,
    })
    return issues
  }

  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!node || typeof node !== 'object') {
      issues.push({
        path: `definition.nodes.${nodeId}`,
        message: 'node definition must be an object',
        value: node,
      })
      continue
    }

    const label = (node as any).label
    if (label != null && typeof label !== 'string') {
      issues.push({
        path: `definition.nodes.${nodeId}.label`,
        message: 'label must be a string when provided',
        value: label,
      })
    }

    const fn = (node as any).function
    if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
      issues.push({
        path: `definition.nodes.${nodeId}.function`,
        message: 'function must be an object',
        value: fn,
      })
    } else {
      const functionId = (fn as any).id
      if (typeof functionId !== 'string' || functionId.length === 0) {
        issues.push({
          path: `definition.nodes.${nodeId}.function.id`,
          message: 'function.id must be a non-empty string',
          value: functionId,
        })
      }

      const queue = (fn as any).queue
      if (queue != null && typeof queue !== 'string') {
        issues.push({
          path: `definition.nodes.${nodeId}.function.queue`,
          message: 'function.queue must be a string when provided',
          value: queue,
        })
      }
    }

    const input = (node as any).input
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      issues.push({
        path: `definition.nodes.${nodeId}.input`,
        message: 'input must be an object',
        value: input,
      })
      continue
    }

    const from = (input as any).from
    const fromIsString = typeof from === 'string'
    const fromIsStringArray = Array.isArray(from) && from.every(item => typeof item === 'string')

    if (!fromIsString && !fromIsStringArray) {
      issues.push({
        path: `definition.nodes.${nodeId}.input.from`,
        message: 'from must be a string or string[]',
        value: from,
      })
    }

    const template = (input as any).template
    if (template != null && typeof template !== 'string') {
      issues.push({
        path: `definition.nodes.${nodeId}.input.template`,
        message: 'template must be a string when provided',
        value: template,
      })
    }

    const dependsOn = (node as any).depends_on
    if (dependsOn != null) {
      if (!Array.isArray(dependsOn) || !dependsOn.every((dep) => typeof dep === 'string')) {
        issues.push({
          path: `definition.nodes.${nodeId}.depends_on`,
          message: 'depends_on must be string[] when provided',
          value: dependsOn,
        })
      }
    }

    const fanout = (node as any).fanout
    if (fanout != null) {
      if (!fanout || typeof fanout !== 'object' || Array.isArray(fanout)) {
        issues.push({
          path: `definition.nodes.${nodeId}.fanout`,
          message: 'fanout must be an object when provided',
          value: fanout,
        })
      } else {
        const over = (fanout as any).over
        if (typeof over !== 'string' || over.length === 0) {
          issues.push({
            path: `definition.nodes.${nodeId}.fanout.over`,
            message: 'fanout.over must be a non-empty string',
            value: over,
          })
        }

        const mode = (fanout as any).mode
        if (mode != null && mode !== 'parallel' && mode !== 'sequential' && mode !== 'batch') {
          issues.push({
            path: `definition.nodes.${nodeId}.fanout.mode`,
            message: 'fanout.mode must be parallel, sequential, or batch when provided',
            value: mode,
          })
        }

        const batchSize = (fanout as any).batchSize
        if (batchSize != null) {
          if (!Number.isInteger(batchSize) || batchSize <= 0) {
            issues.push({
              path: `definition.nodes.${nodeId}.fanout.batchSize`,
              message: 'fanout.batchSize must be a positive integer when provided',
              value: batchSize,
            })
          }
          if (mode !== 'batch') {
            issues.push({
              path: `definition.nodes.${nodeId}.fanout.batchSize`,
              message: 'fanout.batchSize is only valid when fanout.mode is batch',
              value: batchSize,
            })
          }
        }

        const itemReturnType = (fanout as any).itemReturnType
        if (itemReturnType != null && itemReturnType !== 'memory' && itemReturnType !== 'store') {
          issues.push({
            path: `definition.nodes.${nodeId}.fanout.itemReturnType`,
            message: 'fanout.itemReturnType must be memory or store when provided',
            value: itemReturnType,
          })
        }
      }
    }

    const result = (node as any).result
    if (result != null) {
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        issues.push({
          path: `definition.nodes.${nodeId}.result`,
          message: 'result must be an object when provided',
          value: result,
        })
      } else {
        const returnType = (result as any).returnType
        if (returnType != null && returnType !== 'memory' && returnType !== 'store' && returnType !== 'stream') {
          issues.push({
            path: `definition.nodes.${nodeId}.result.returnType`,
            message: 'result.returnType must be memory, store, or stream when provided',
            value: returnType,
          })
        }

        const streamChunkSize = (result as any).streamChunkSize
        if (streamChunkSize != null && (typeof streamChunkSize !== 'number' || Number.isNaN(streamChunkSize) || streamChunkSize <= 0)) {
          issues.push({
            path: `definition.nodes.${nodeId}.result.streamChunkSize`,
            message: 'result.streamChunkSize must be a positive number when provided',
            value: streamChunkSize,
          })
        }

        const onMemoryFail = (result as any).onMemoryFail
        if (onMemoryFail != null && onMemoryFail !== 'store' && onMemoryFail !== 'error') {
          issues.push({
            path: `definition.nodes.${nodeId}.result.onMemoryFail`,
            message: 'result.onMemoryFail must be store or error when provided',
            value: onMemoryFail,
          })
        }
      }
    }

    const inputPolicy = (node as any).inputPolicy
    if (inputPolicy != null) {
      if (!inputPolicy || typeof inputPolicy !== 'object' || Array.isArray(inputPolicy)) {
        issues.push({
          path: `definition.nodes.${nodeId}.inputPolicy`,
          message: 'inputPolicy must be an object when provided',
          value: inputPolicy,
        })
      } else {
        const returnType = (inputPolicy as any).returnType
        if (returnType != null && returnType !== 'memory' && returnType !== 'store') {
          issues.push({
            path: `definition.nodes.${nodeId}.inputPolicy.returnType`,
            message: 'inputPolicy.returnType must be memory or store when provided',
            value: returnType,
          })
        }

        const onMemoryFail = (inputPolicy as any).onMemoryFail
        if (onMemoryFail != null && onMemoryFail !== 'store' && onMemoryFail !== 'error') {
          issues.push({
            path: `definition.nodes.${nodeId}.inputPolicy.onMemoryFail`,
            message: 'inputPolicy.onMemoryFail must be store or error when provided',
            value: onMemoryFail,
          })
        }
      }
    }
  }

  const outFrom = plan?.output?.from
  if (typeof outFrom !== 'string' || outFrom.length === 0) {
    issues.push({
      path: 'definition.output.from',
      message: 'output.from must be a non-empty string',
      value: outFrom,
    })
  }

  return issues
}

export function serializeWorkflowDefinitionOrThrow(plan: WorkflowPlanLike) {
  const serializable = JSON.parse(JSON.stringify(plan)) as WorkflowPlanLike
  sanitizeWorkflowPlanInputFrom(serializable)

  const issues = collectWorkflowPlanSerializationIssues(serializable)
  if (issues.length === 0) return serializable

  const details = issues
    .map(issue => `${issue.path}: ${issue.message}; got=${JSON.stringify(issue.value)}`)
    .join(' | ')

  throw new Error(
    `workflow definition contains non-serializable input references for nworkflow::start: ${details}`,
  )
}

export function summarizeWorkflowDefinitionShape(plan: WorkflowPlanLike) {
  const nodes = plan?.nodes && typeof plan.nodes === 'object' ? plan.nodes : {}

  return Object.entries(nodes).map(([nodeId, node]) => {
    const rec = node as any
    const input = rec?.input
    const functionSpec = rec?.function
    const fanout = rec?.fanout

    return {
      nodeId,
      functionIdType: typeof functionSpec?.id,
      functionId: functionSpec?.id,
      inputFromType: Array.isArray(input?.from) ? 'array' : typeof input?.from,
      inputFrom: input?.from,
      inputTemplateType: typeof input?.template,
      fanoutOverType: typeof fanout?.over,
      fanoutOver: fanout?.over,
      dependsOnType: Array.isArray(rec?.depends_on) ? 'array' : typeof rec?.depends_on,
      dependsOn: rec?.depends_on,
    }
  })
}