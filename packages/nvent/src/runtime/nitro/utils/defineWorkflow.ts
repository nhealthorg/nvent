import { useIii } from '#imports'

/**
 * Lazy-loaded registry cache to avoid circular dependencies.
 * Registry is loaded on first access.
 */
let registryCache: any = null

async function getRegistry() {
  if (!registryCache) {
    try {
      // Dynamically import registry to avoid build-time issues
      const mod = await import('#nvent/iii-registry')
      registryCache = mod.default || mod.registry
    } catch (e) {
      console.warn('[nvent/workflow] Failed to load function registry:', e)
      registryCache = { functions: [] }
    }
  }
  return registryCache
}

/**
 * Get runtime from function registry.
 * Falls back to heuristics if registry is not available.
 */
async function getRuntimeFromRegistry(functionId: string): Promise<'nodejs' | 'python' | 'rust' | 'unknown'> {
  try {
    const registry = await getRegistry()
    
    if (registry?.functions) {
      const fn = registry.functions.find((f: any) => f.id === functionId)
      if (fn?.runtime) {
        return fn.runtime
      }
    }
  } catch (e) {
    // Registry not available, fall back to heuristics
  }
  
  return detectFunctionRuntime(functionId)
}

/**
 * Detect function runtime from ID pattern.
 * Heuristics:
 * - Ends with '.py' or contains 'python' → python
 * - Contains '::' (Rust convention for module paths) → rust
 * - Otherwise → nodejs (default, since defineWorkflow runs in Node.js context)
 */
function detectFunctionRuntime(functionId: string): 'nodejs' | 'python' | 'rust' | 'unknown' {
  const lower = functionId.toLowerCase()
  
  // Python detection
  if (functionId.endsWith('.py') || lower.includes('python')) {
    return 'python'
  }
  
  // Rust detection (module path syntax like "module::function")
  if (functionId.includes('::')) {
    return 'rust'
  }
  
  // Default to nodejs since we're in a Node.js context
  // Most functions registered via defineFunction are Node.js
  return 'nodejs'
}

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
  /**
   * Low-level node definition (full control over spec)
   */
  node: <T = any>(id: string, spec: any) => Promise<T>
  
  /**
   * High-level helper: call a function with automatic input mapping.
   * 
   * @param nodeIdOrFunctionId - If only one arg, used as both node ID and function ID
   * @param functionIdOrInput - Function ID if 2 args, or input if 1 arg
   * @param input - Input data (optional, defaults to previous node or run_input)
   * 
   * @example
   * // Simple call with auto-generated node ID
   * await ctx.call('process-text', input)
   * 
   * // Call with explicit node ID
   * await ctx.call('step1', 'process-text', input)
   * 
   * // Call referencing previous node
   * const result1 = await ctx.call('process', input)
   * const result2 = await ctx.call('analyze', result1)
   */
  call: <T = any>(...args: any[]) => Promise<T>
  
  /**
   * Fanout helper: run a function for each item in an array.
   * 
   * @param nodeId - Node ID for the fanout group
   * @param items - Array reference (e.g., previous node result)
   * @param functionId - Function to run for each item
   * 
   * @example
   * const items = await ctx.call('fetch-items')
   * await ctx.foreach('process-items', items, 'process-single-item')
   */
  foreach: <T = any>(nodeId: string, items: any, functionId: string) => Promise<T>
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
          definition: {
            ...plan,
            // Add workflow metadata for UI display
            metadata: {
              name: options.name,
              description: options.description,
              created_by_worker: `nvent-nodejs-${process.pid}`,
            },
          },
          input
        }
      })
    },
    async compile(input: TInput = {} as any) {
      const nodes: Record<string, any> = {}
      const nodeOrder: string[] = []
      let autoNodeCounter = 0

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
            const fnSpec = typeof spec.function === 'string' ? { id: spec.function } : spec.function
            
            // Get runtime from registry instead of guessing
            if (!fnSpec.runtime) {
              fnSpec.runtime = await getRuntimeFromRegistry(fnSpec.id)
            }
            
            nodeDef.function = fnSpec
          } else if (spec.executor) {
            // Passthrough for raw executor structure
            Object.assign(nodeDef, spec.executor)
          }

          nodes[id] = nodeDef
          nodeOrder.push(id)
          return { $ref: `node:${id}` } as any
        },
        
        call: async (...args: any[]) => {
          // Parse arguments: call(functionId, input) OR call(nodeId, functionId, input)
          let nodeId: string
          let functionId: string
          let input: any
          
          if (args.length === 1) {
            // call(functionId) - auto-generate node ID, use run_input
            functionId = args[0]
            nodeId = functionId.replace(/::/g, '_')
            input = 'run_input'
          } else if (args.length === 2) {
            if (typeof args[0] === 'string' && typeof args[1] === 'string') {
              // call(nodeId, functionId) - explicit IDs, use run_input
              nodeId = args[0]
              functionId = args[1]
              input = 'run_input'
            } else {
              // call(functionId, input) - auto-generate node ID
              functionId = args[0]
              nodeId = functionId.replace(/::/g, '_')
              input = args[1]
            }
          } else {
            // call(nodeId, functionId, input) - all explicit
            nodeId = args[0]
            functionId = args[1]
            input = args[2]
          }
          
          // If nodeId collision, append counter
          if (nodes[nodeId]) {
            nodeId = `${nodeId}_${++autoNodeCounter}`
          }
          
          return ctx.node(nodeId, {
            function: functionId,
            input
          })
        },
        
        foreach: async (nodeId: string, items: any, functionId: string) => {
          // Extract the 'from' reference from items if it's a node reference
          let fanoutOver: string
          if (items && typeof items === 'object' && items.$ref) {
            fanoutOver = items.$ref
          } else if (typeof items === 'string') {
            fanoutOver = items
          } else {
            throw new Error(`foreach requires a node reference or string path, got: ${typeof items}`)
          }
          
          return ctx.node(nodeId, {
            function: functionId,
            input: 'fanout_item',
            fanout: { over: fanoutOver }
          })
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

