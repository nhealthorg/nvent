import { useIii } from '#imports'
/**
 * Normalizes various input formats into the InputSpec format expected by the workflow worker.
 * 
 * InputSpec shape: { from: string | string[], template?: string }
 * 
 * @param input - User-provided input specification
 * @param deps - Auto-inferred dependencies from $ref references
 */
function normalizeInput(input: any, deps: string[]): { from: string | string[], template?: string } {
  // Case 1: String shorthand - wrap in { from }
  if (typeof input === 'string') {
    return { from: input }
  }
  
  // Case 2: Array shorthand (for multi-node joins) - wrap in { from }
  if (Array.isArray(input)) {
    return { from: input }
  }
  
  // Case 3: Already a valid InputSpec with 'from' field
  if (input && typeof input === 'object' && 'from' in input) {
    return input
  }
  
  // Case 4: Node reference via $ref (returned by ctx.node) - convert to 'from'
  if (input && typeof input === 'object' && '$ref' in input && typeof input.$ref === 'string') {
    return { from: input.$ref }
  }
  
  // Case 5: No input provided - infer from dependencies
  if (!input) {
    if (deps.length === 1) {
      return { from: `node:${deps[0]}` }
    }
    return { from: 'run_input' }
  }
  
  // Case 6: Invalid - object without 'from' or '$ref' field
  // This might be the user trying to pass custom data, which doesn't fit the DAG model
  // For now, warn and default to run_input
  console.warn(
    `[nvent/workflow] Invalid input specification. Expected string, array, or object with 'from' field.`,
    `Got:`, input,
    `\nDefaulting to 'run_input'. To pass workflow input to a node, use: input: 'run_input'`
  )
  return { from: 'run_input' }
}
export interface WorkflowContext {
  node: <T = any>(id: string, spec: any) => Promise<T>
}

export type WorkflowHandler<TInput = any, TOutput = any> = (
  ctx: WorkflowContext,
  input: TInput
) => Promise<TOutput>

export interface WorkflowOptions<TInput = any, TOutput = any> {
  name: string
  handler: WorkflowHandler<TInput, TOutput>
  description?: string
  triggers?: any[]
  request_format?: Record<string, any>
  response_format?: Record<string, any>
}

/**
 * defineWorkflow — declares a functional DAG workflow.
 * 
 * Workflows are registered as standard iii functions. When triggered, the 
 * handler compiles the local JS workflow definition into a static DAG plan 
 * and sends it to the workflow-worker via `workflow::start`.
 */
export function defineWorkflow<TInput = any, TOutput = any>(
  options: WorkflowOptions<TInput, TOutput>
) {
  const workflow = {
    ...options,
    $workflow: true,
    // The "nvent" generic function handler. 
    // When called as a standard function (e.g. via iii.trigger), it compiles 
    // the workflow and starts the execution via the workflow-worker.
    async handler(input: TInput) {
      const plan = await workflow.compile(input)
      const iii = useIii()
      return iii.trigger({
        function_id: 'workflow::start',
        payload: {
          definition: plan,
          input
        }
      })
    },
    async compile(input: TInput = {} as any) {
      const nodes: Record<string, any> = {}
      const nodeOrder: string[] = []

      const ctx: WorkflowContext = {
        node: async (id, spec) => {
          const dependsOn = new Set<string>()
          
          const findDeps = (obj: any) => {
            if (!obj || typeof obj !== 'object') return
            if (obj && obj.$ref && typeof obj.$ref === 'string' && obj.$ref.startsWith('node:')) {
              dependsOn.add(obj.$ref.split(':')[1])
            } else {
              for (const key in obj) findDeps(obj[key])
            }
          }
          findDeps(spec)

          // Auto-infer dependencies from $ref in the spec
          const deps = Array.from(dependsOn)
          
          // Map to Rust NodeDef structure
          const nodeDef: any = {
            depends_on: spec.depends_on || deps,
            input: normalizeInput(spec.input, deps),
            fanout: typeof spec.fanout === 'string' ? { over: spec.fanout } : spec.fanout,
          }

          // Handle executor
          if (spec.agent) {
            nodeDef.agent = typeof spec.agent === 'string' ? { model: spec.agent } : spec.agent
          } else if (spec.function) {
            nodeDef.function = typeof spec.function === 'string' ? { id: spec.function } : spec.function
          } else if (spec.executor) {
            // Passthrough for raw executor structure
            Object.assign(nodeDef, spec.executor)
          }

          nodes[id] = nodeDef
          nodeOrder.push(id)
          return { $ref: `node:${id}` } as any
        }
      }

      const result = await options.handler(ctx, input)
      let outputNode = ''
      if (result && typeof result === 'object' && (result as any).$ref) {
        outputNode = (result as any).$ref.replace('node:', '')
      } else if (nodeOrder.length > 0) {
        outputNode = nodeOrder[nodeOrder.length - 1]!
      }

      return {
        nodes,
        output: { from: outputNode }
      }
    }
  }

  return workflow
}

