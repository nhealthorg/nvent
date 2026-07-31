import { useIii } from '#imports'
import type { TriggerConfig } from './defineFunction'
import type { WorkflowRunRecord } from './workflow-types'

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
async function getFunctionExecutionConfig(functionId: string): Promise<{
  label?: string
  runtime: 'nodejs' | 'python' | 'rust' | 'unknown'
  queue?: string
  engine_retry?: { max_attempts?: number }
}> {
  try {
    const registry = await getRegistry()
    
    if (registry?.functions) {
      const fn = registry.functions.find((f: any) => f.id === functionId)
      if (fn) {
        const queue = typeof fn.workflow === 'object' && typeof fn.workflow.queue === 'string'
          ? fn.workflow.queue
          : undefined
        return {
          label: typeof fn.label === 'string' ? fn.label : undefined,
          runtime: fn.runtime || 'unknown',
          queue,
          engine_retry: typeof fn.workflow === 'object' && fn.workflow.engine_retry
            ? fn.workflow.engine_retry
            : undefined,
        }
      }
    }
  } catch (e) {
    // Registry not available, fall back to heuristics
  }
  
  return { runtime: 'unknown' }
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

/**
 * Extracts a plain JSON Schema object from a schema library instance (e.g. Zod v4).
 * @internal
 */
function extractJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const s = schema as Record<string, any>
  if (typeof s.parse !== 'function') return s // raw JSON Schema
  if (typeof s.toJsonSchema === 'function') return s.toJsonSchema()
  return undefined
}

export interface WorkflowContext {
  /**
   * Low-level node definition (full control over spec)
   */
  node: <T = any>(id: string, spec: {
    label?: string
    function?: string | {
      id: string
      runtime?: 'nodejs' | 'python' | 'rust' | 'unknown'
      queue?: string
      engine_retry?: { max_attempts?: number }
    }
    input?: any
    retry?: { max_attempts?: number }
    depends_on?: string[]
    fanout?: string | { over: string, mode?: 'parallel' | 'sequential' }
    agent?: any
    executor?: any
  }) => Promise<T>
  
  /**
   * High-level helper: call a function with automatic input mapping.
    *
    * Optional last argument can override function execution config per node:
    * `{ queue, runtime, engine_retry }` (or `{ retry }` shorthand).
    * These call/node-level values override defaults from defineFunction({ workflow }).
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
   * Loop over a runtime array source and execute one or more calls per item.
   *
   * The array source may come from a previous node (dynamic at runtime).
   * Inside the callback, `loop.item` represents the current item value.
   *
   * @example
   * const items = await ctx.call('load-items', input)
   *
   * await ctx.loop(items, async loop => {
   *   const prepared = await loop.call('prepare-item', loop.item)
   *   return loop.call('process-item', prepared)
   * })
   */
  loop: <T = any>(items: any, fn: (ctx: WorkflowLoopContext) => T | Promise<T>, options?: WorkflowLoopOptions) => Promise<T>

  /**
   * Declare one logical parallel branch that can contain sequential steps.
   * Use with ctx.all to run several branches concurrently in the DAG.
   *
   * @example
   * await ctx.all(c => [
   *   c.branch(async b => {
   *     const a = await b.call('step-a', input)
   *     return b.call('step-b', a)
   *   }),
   *   c.branch(async b => {
   *     const x = await b.call('step-x', input)
   *     return b.call('step-y', x)
   *   }),
   * ] as const)
   */
  branch: <T = any>(fn: (ctx: WorkflowContext) => T | Promise<T>) => WorkflowParallelBranch<T>

  /**
   * Fanout helper: run a function for each item in an array.
   * @param nodeId - ID of the foreach node
   * @param items - Array of items to process
   * @param functionId - ID of the function to call for each item
   * 
   * @example
   * await ctx.foreach('process-items', items, 'process-item')
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
  all: <T extends readonly unknown[]>(fn: (ctx: WorkflowContext) => T | Promise<T>) => Promise<{ [K in keyof T]: T[K] extends Promise<infer R> ? R : T[K] }>
}

export interface WorkflowLoopContext extends WorkflowContext {
  /** Current loop item token (maps to fanout_item at runtime). */
  item: WorkflowLoopItemRef
}

export type WorkflowLoopMode = 'parallel' | 'sequential'

export interface WorkflowLoopOptions {
  /**
   * Loop execution mode:
   * - parallel (default): all items can run concurrently
   * - sequential: process one item at a time in index order
   */
  mode?: WorkflowLoopMode
}

const WORKFLOW_BRANCH = Symbol('workflow.branch')
const WORKFLOW_LOOP_ITEM = Symbol('workflow.loop.item')

export type WorkflowParallelBranch<T = any> = {
  [WORKFLOW_BRANCH]: true
  run: (ctx: WorkflowContext) => T | Promise<T>
}

export type WorkflowLoopItemRef = {
  [WORKFLOW_LOOP_ITEM]: true
}

function isWorkflowParallelBranch(value: unknown): value is WorkflowParallelBranch<any> {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as any)[WORKFLOW_BRANCH] === true
    && typeof (value as any).run === 'function',
  )
}

function isWorkflowLoopItemRef(value: unknown): value is WorkflowLoopItemRef {
  return Boolean(value && typeof value === 'object' && (value as any)[WORKFLOW_LOOP_ITEM] === true)
}

type CallOptions = {
  label?: string
  queue?: string
  runtime?: 'nodejs' | 'python' | 'rust' | 'unknown'
  engine_retry?: { max_attempts?: number }
  retry?: { max_attempts?: number }
}

function isCallOptions(value: unknown): value is CallOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return 'label' in v || 'queue' in v || 'runtime' in v || 'engine_retry' in v || 'retry' in v
}

type ParsedCall = {
  nodeId: string
  functionId: string
  input: any
  callOptions?: CallOptions
}

function parseCallArguments(args: any[]): ParsedCall {
  const work = [...args]
  let callOptions: CallOptions | undefined
  if (work.length > 0 && isCallOptions(work[work.length - 1])) {
    callOptions = work.pop()
  }

  let nodeId: string
  let functionId: string
  let input: any

  if (work.length === 1) {
    functionId = work[0]
    nodeId = functionId
    input = 'run_input'
  }
  else if (work.length === 2) {
    if (typeof work[0] === 'string' && typeof work[1] === 'string') {
      nodeId = work[0]
      functionId = work[1]
      input = 'run_input'
    } else {
      functionId = work[0]
      nodeId = functionId
      input = work[1]
    }
  }
  else {
    nodeId = work[0]
    functionId = work[1]
    input = work[2]
  }

  return {
    nodeId,
    functionId,
    input,
    callOptions,
  }
}

function buildFunctionSpec(functionId: string, callOptions?: CallOptions) {
  if (!callOptions) return functionId
  return {
    id: functionId,
    ...(callOptions.runtime ? { runtime: callOptions.runtime } : {}),
    ...(callOptions.queue ? { queue: callOptions.queue } : {}),
    ...((callOptions.engine_retry || callOptions.retry)
      ? { engine_retry: callOptions.engine_retry ?? callOptions.retry }
      : {}),
  }
}

export type WorkflowHandler<TInput = any, TOutput = any> = (
  input: TInput,
  ctx: WorkflowContext,
) => TOutput | Promise<TOutput>

/** Any schema library with a parse method (Zod, Valibot, etc.) */
type Parseable<T = unknown> = { parse(data: unknown): T }

/** @internal Infers the handler input type from the declared trigger configs. */
type InferHandlerInput<TTriggers extends TriggerConfig[]> =
  [TTriggers[number]['type']] extends ['http'] ? import('./defineFunction').HttpRequest : unknown

export interface WorkflowOptions<TInput = any, TOutput = any, TTriggers extends TriggerConfig[] = TriggerConfig[]> {
  name?: string
  handler: WorkflowHandler<TInput, TOutput>
  description?: string
  hooks?: {
    onStart?: string
    onEnd?: string
    onError?: string
    onDelete?: string
  }
  triggers?: TTriggers
  /** Schema for the handler input. Infers the TypeScript type and auto-extracts JSON Schema for iii. */
  input?: Parseable<TInput>
  /** Schema for the handler output. Infers the TypeScript type and auto-extracts JSON Schema for iii. */
  output?: Parseable<TOutput>
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
export function defineWorkflow<
  TInSchema extends Parseable<any> | undefined = undefined,
  TOutSchema extends Parseable<any> | undefined = undefined,
  TTriggers extends TriggerConfig[] = TriggerConfig[],
  TInput = TInSchema extends Parseable<infer T> ? T : InferHandlerInput<TTriggers>,
  TOutput = TOutSchema extends Parseable<infer T> ? T : any,
>(
  options: WorkflowOptions<TInput, TOutput, TTriggers>
) {
  // Extract JSON schemas if provided via input/output
  const request_format = options.request_format ?? (options.input ? extractJsonSchema(options.input) : undefined)
  const response_format = options.response_format ?? (options.output ? extractJsonSchema(options.output) : undefined)

  const workflow = {
    ...options,
    request_format,
    response_format,
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
              hooks: options.hooks ? {
                on_start: options.hooks.onStart,
                on_end: options.hooks.onEnd,
                on_error: options.hooks.onError,
                on_delete: options.hooks.onDelete,
              } : undefined,
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
      let parallelFixedFrontier: string[] | null = null

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

      const resolveFanoutOver = (items: any): string => {
        if (items && typeof items === 'object' && '$ref' in items && typeof items.$ref === 'string') {
          return items.$ref
        }
        if (typeof items === 'string') {
          return items
        }
        throw new Error(`loop requires a node reference or string path, got: ${typeof items}`)
      }

      const resolveLoopMode = (options?: WorkflowLoopOptions): WorkflowLoopMode => {
        if (options?.mode === 'sequential') return 'sequential'
        return 'parallel'
      }

      const applyAutoNodeSuffix = (id: string): string => {
        if (nodes[id]) return `${id}_${++autoNodeCounter}`
        return id
      }

      const ctx: WorkflowContext = {
        node: async (id, spec) => {
          const dataDepSet = new Set<string>()
          collectNodeRefs(spec, dataDepSet)

          const dataDeps = [...dataDepSet]
          const declaredDeps = Array.isArray(spec.depends_on) ? spec.depends_on : []
          const baseControlDeps = (parallelCollector && parallelFixedFrontier)
            ? parallelFixedFrontier
            : controlFrontier
          const combinedDeps = [...baseControlDeps, ...declaredDeps, ...dataDeps]
          const dependsOn = reduceDependencies(combinedDeps)

          // Map to Rust NodeDef structure
          const nodeDef: any = {
            label: spec.label,
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

            if (!fnSpec.engine_retry && spec.retry) {
              fnSpec.engine_retry = spec.retry
            }
            
            // Get runtime from registry instead of guessing
            if (!fnSpec.runtime || !fnSpec.queue || !fnSpec.engine_retry || !nodeDef.label) {
              const execution = await getFunctionExecutionConfig(fnSpec.id)

              if (!nodeDef.label && execution.label) nodeDef.label = execution.label
              if (!fnSpec.runtime) fnSpec.runtime = execution.runtime
              if (!fnSpec.queue && execution.queue) fnSpec.queue = execution.queue
              if (!fnSpec.engine_retry && execution.engine_retry) fnSpec.engine_retry = execution.engine_retry
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
          const parsed = parseCallArguments(args)
          const nodeId = applyAutoNodeSuffix(parsed.nodeId)
          const functionSpec = buildFunctionSpec(parsed.functionId, parsed.callOptions)
          
          return ctx.node(nodeId, {
            label: parsed.callOptions?.label,
            function: functionSpec,
            input: parsed.input
          })
        },

        loop: async <T = any>(items: any, fn: (loopCtx: WorkflowLoopContext) => T | Promise<T>, options?: WorkflowLoopOptions): Promise<T> => {
          const fanoutOver = resolveFanoutOver(items)
          const loopMode = resolveLoopMode(options)
          const loopItemRef: WorkflowLoopItemRef = {
            [WORKFLOW_LOOP_ITEM]: true,
          }

          const loopCtx: WorkflowLoopContext = {
            ...ctx,
            item: loopItemRef,
            call: async (...args: any[]) => {
              const parsed = parseCallArguments(args)
              const nodeId = applyAutoNodeSuffix(parsed.nodeId)
              const functionSpec = buildFunctionSpec(parsed.functionId, parsed.callOptions)
              const isItemInput = isWorkflowLoopItemRef(parsed.input)

              return ctx.node(nodeId, {
                label: parsed.callOptions?.label,
                function: functionSpec,
                input: isItemInput ? 'fanout_item' : parsed.input,
                fanout: {
                  over: fanoutOver,
                  ...(loopMode !== 'parallel' ? { mode: loopMode } : {}),
                },
              })
            },
            foreach: async (nodeId: string, nestedItems: any, functionId: string) => {
              const nestedOver = resolveFanoutOver(nestedItems)
              return ctx.node(applyAutoNodeSuffix(nodeId), {
                function: functionId,
                input: 'fanout_item',
                fanout: { over: nestedOver },
              })
            },
            loop: async <U = any>(nestedItems: any, nestedFn: (nestedCtx: WorkflowLoopContext) => U | Promise<U>, nestedOptions?: WorkflowLoopOptions): Promise<U> => {
              return ctx.loop(nestedItems, nestedFn, nestedOptions)
            },
          }

          return await fn(loopCtx)
        },

        branch: <T = any>(fn: (c: WorkflowContext) => T | Promise<T>): WorkflowParallelBranch<T> => ({
          [WORKFLOW_BRANCH]: true,
          run: fn,
        }),
        
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

        all: async <T extends readonly unknown[]>(fn: (c: WorkflowContext) => T | Promise<T>) => {
          const previousCollector = parallelCollector
          const previousFrontier = [...controlFrontier]
          const previousFixedFrontier = parallelFixedFrontier

          // Activate collection BEFORE creating tasks so sibling calls inside
          // fn(ctx) are compiled from the same frontier (true parallel leaves).
          parallelCollector = []
          parallelFixedFrontier = [...previousFrontier]
          const tasks = await fn(ctx)
          const taskList = Array.from(tasks as readonly unknown[])

          // Branch mode: each branch starts from the same pre-all frontier,
          // but can advance sequentially inside the branch.
          if (taskList.some(task => isWorkflowParallelBranch(task))) {
            const branchResults: unknown[] = new Array(taskList.length)

            // Resolve non-branch tasks first while collector is active.
            // This avoids races where still-running legacy tasks would mutate
            // collector while branch mode temporarily isolates frontier state.
            for (let i = 0; i < taskList.length; i++) {
              const task = taskList[i]
              if (!isWorkflowParallelBranch(task)) {
                branchResults[i] = await Promise.resolve(task)
              }
            }

            const completedParallelNodes: string[] = [...(parallelCollector ?? [])]

            for (let i = 0; i < taskList.length; i++) {
              const task = taskList[i]
              if (!isWorkflowParallelBranch(task)) {
                continue
              }

              const savedCollector: string[] | null = parallelCollector
              const savedFrontier = [...controlFrontier]
              const savedFixedFrontier: string[] | null = parallelFixedFrontier

              parallelCollector = null
              parallelFixedFrontier = null
              controlFrontier = [...previousFrontier]

              const branchResult = await task.run(ctx)
              branchResults[i] = branchResult

              if (controlFrontier.length > 0) {
                completedParallelNodes.push(...controlFrontier)
              }

              parallelCollector = savedCollector
              parallelFixedFrontier = savedFixedFrontier
              controlFrontier = savedFrontier
            }

            const mergedFrontier = completedParallelNodes.length > 0
              ? reduceDependencies(completedParallelNodes)
              : previousFrontier

            parallelCollector = previousCollector
            parallelFixedFrontier = previousFixedFrontier
            if (parallelCollector) {
              parallelCollector.push(...mergedFrontier)
            } else {
              controlFrontier = mergedFrontier
            }

            return branchResults as any
          }

          // Legacy mode: every task in this all() block is an independent parallel leaf.
          const results = await Promise.all(taskList)
          const completedParallelNodes = parallelCollector
          parallelCollector = previousCollector
          parallelFixedFrontier = previousFixedFrontier

          if ((completedParallelNodes?.length ?? 0) > 0) {
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

      const result = await options.handler(input, ctx)
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

