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
  
  return 'unknown'
}

/**
 * Normalizes various input formats into the InputSpec format expected by the workflow worker.
 * 
 * InputSpec shape: { from: string | string[], template?: string }
 */
function normalizeInput(input: any, deps: string[]): { from: string | string[], template?: string } {
  // Case 1: String shorthand - wrap in { from }
  if (typeof input === 'string') {
    return { from: input }
  }
  
  // Case 2: Array shorthand (for multi-node joins) - wrap in { from }
  if (Array.isArray(input)) {
    return {
      from: input.map((item) => {
        if (item && typeof item === 'object' && '$ref' in item && typeof item.$ref === 'string') {
          return item.$ref
        }
        return item
      }),
    }
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

  // Case 6: User passed a raw object (e.g. from the workflow handler's `input` argument)
  // In a static DAG, we can't embed the actual values in the plan reliably, 
  // so we treat passing ANY object that looks like the root input as a request for 'run_input'.
  if (typeof input === 'object' && !Array.isArray(input)) {
    return { from: 'run_input' }
  }
  
  // Case 7: Invalid - fallback
  console.warn(
    `[nvent/workflow] Unexpected input type: ${typeof input}. Defaulting to 'run_input'.`
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
   */
  foreach: <T = any>(nodeId: string, items: any, functionId: string) => Promise<T>
  
  /**
   * Run multiple tasks in parallel.
   * 
   * @param tasks - Array of ctx.call or ctx.node promises
   * 
   * @example
   * const [res1, res2] = await ctx.all(c => [
   *   c.call('task1', input),
   *   c.call('task2', input)
   * ])
   */
  all: <T extends readonly unknown[]>(fn: (ctx: WorkflowContext) => T) => Promise<{ [K in keyof T]: T[K] extends Promise<infer R> ? R : T[K] }>
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
      let controlFrontier: string[] = []
      let parallelCollector: string[] | null = null

      const collectNodeRefs = (obj: any, refs: Set<string>) => {
        if (!obj || typeof obj !== 'object') return
        if (obj.$ref && typeof obj.$ref === 'string' && obj.$ref.startsWith('node:')) {
          refs.add(obj.$ref.split(':')[1])
          return
        }
        if (Array.isArray(obj)) {
          for (const item of obj) collectNodeRefs(item, refs)
          return
        }
        for (const key in obj) collectNodeRefs(obj[key], refs)
      }

      const getDirectDeps = (nodeId: string): string[] => {
        const node = nodes[nodeId]
        return Array.isArray(node?.depends_on) ? node.depends_on : []
      }

      const getAncestors = (nodeId: string): Set<string> => {
        const ancestors = new Set<string>()
        const stack = [...getDirectDeps(nodeId)]

        while (stack.length > 0) {
          const currentId = stack.pop()!
          if (ancestors.has(currentId)) continue
          ancestors.add(currentId)
          stack.push(...getDirectDeps(currentId))
        }

        return ancestors
      }

      const reduceDependencies = (deps: string[]): string[] => {
        const uniqueDeps = [...new Set(deps)]

        return uniqueDeps.filter((candidate) => {
          return !uniqueDeps.some((other) => {
            if (other === candidate) return false
            return getAncestors(other).has(candidate)
          })
        })
      }

      const ctx: WorkflowContext = {
        node: async (id, spec) => {
          const dataDepSet = new Set<string>()
          collectNodeRefs(spec, dataDepSet)

          const dataDeps = [...dataDepSet]
          const declaredDeps = Array.isArray(spec.depends_on) ? spec.depends_on : []
          const combinedDeps = [...controlFrontier, ...declaredDeps, ...dataDeps]
          const dependsOn = reduceDependencies(combinedDeps)

          // Map to Rust NodeDef structure
          const nodeDef: any = {
            depends_on: dependsOn,
            input: normalizeInput(spec.input, dataDeps),
            fanout: typeof spec.fanout === 'string' ? { over: spec.fanout } : spec.fanout,
          }

          // Update control-flow frontier
          if (parallelCollector) {
            parallelCollector.push(id)
          } else {
            controlFrontier = [id]
          }

          // If the input was normalized to run_input by the caller, it means they might have 
          // passed the whole object expecting it to be filtered. But Rust worker expects
          // { from: "run_input" } or { from: "node:x" }.
          if (nodeDef.input.from === 'run_input' && spec.input && typeof spec.input === 'object' && !spec.input.$ref) {
             // This was likely a raw object passed to call(fn, { ... })
             // In the functional DAG model, we can't pass raw JS objects yet, 
             // so we stay with run_input but we should have stopped the warning.
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
        },

        all: async <T extends readonly unknown[]>(fn: (c: WorkflowContext) => T) => {
          const previousCollector = parallelCollector
          const previousFrontier = [...controlFrontier]

          parallelCollector = []

          const tasks = fn(ctx)
          const results = await Promise.all(tasks)

          const completedParallelNodes = parallelCollector
          parallelCollector = previousCollector

          if (completedParallelNodes.length > 0) {
            if (parallelCollector) {
              parallelCollector.push(...completedParallelNodes)
            } else {
              controlFrontier = reduceDependencies(completedParallelNodes)
            }
          } else if (!parallelCollector) {
            controlFrontier = previousFrontier
          }

          return results as any
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

