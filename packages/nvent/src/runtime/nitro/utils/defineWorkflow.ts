import { useIii, useRuntimeConfig } from '#imports'
import type { TriggerConfig } from './defineFunction'
import type { WorkflowRunRecord } from './workflow-types'
import { normalizeWorkflowInput } from './workflow/input-spec'
import { serializeWorkflowDefinitionOrThrow, summarizeWorkflowDefinitionShape } from './workflow/definition-serialization'

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

function normalizeInput(input: any, deps: string[]): { from: string | string[], template?: string, value?: unknown } {
  return normalizeWorkflowInput(input, deps, isWorkflowValueRef)
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
    fanout?: string | { over: string, mode?: 'parallel' | 'sequential' | 'batch', batchSize?: number, itemReturnType?: 'memory' | 'store' }
    result?: {
      returnType?: 'memory' | 'store' | 'stream'
      streamChunkSize?: number
      onMemoryFail?: 'store' | 'error'
    }
    inputPolicy?: {
      returnType?: 'memory' | 'store'
      onMemoryFail?: 'store' | 'error'
    }
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
  call: WorkflowCall

  /**
   * Persist a workflow-scoped variable and return its current value reference.
   * The value can include dynamic refs (e.g. previous-step fields).
   */
  var: <T = any>(key: string, value: any, options?: { label?: string }) => Promise<T>

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

export type WorkflowHookInput = Record<string, unknown>

export type WorkflowHookEvent = 'on_start' | 'on_end' | 'on_error' | 'on_delete'

export interface WorkflowHookBasePayload {
  event: WorkflowHookEvent
  run_id: string
  status: WorkflowRunRecord['status']
  workflow_name?: string
}

export interface WorkflowOnStartHookPayload extends WorkflowHookBasePayload {
  event: 'on_start'
  created_at: number
}

export interface WorkflowOnTerminalHookPayload extends WorkflowHookBasePayload {
  event: 'on_end' | 'on_error'
  result?: unknown
  result_error?: string
  updated_at: number
}

export interface WorkflowOnDeleteHookPayload extends WorkflowHookBasePayload {
  event: 'on_delete'
  was_terminal: boolean
  result?: unknown
  result_error?: string
  deleted_at: number
}

export type WorkflowAnyHookPayload =
  | WorkflowOnStartHookPayload
  | WorkflowOnTerminalHookPayload
  | WorkflowOnDeleteHookPayload

export type WorkflowHookPayloadWithStaticInput<
  TStaticInput extends WorkflowHookInput,
  TPayload extends object,
> = Omit<TStaticInput, keyof TPayload> & TPayload

export type WorkflowOnStartHookInput<TStaticInput extends WorkflowHookInput = WorkflowHookInput> =
  WorkflowHookPayloadWithStaticInput<TStaticInput, WorkflowOnStartHookPayload>

export type WorkflowOnTerminalHookInput<TStaticInput extends WorkflowHookInput = WorkflowHookInput> =
  WorkflowHookPayloadWithStaticInput<TStaticInput, WorkflowOnTerminalHookPayload>

export type WorkflowOnDeleteHookInput<TStaticInput extends WorkflowHookInput = WorkflowHookInput> =
  WorkflowHookPayloadWithStaticInput<TStaticInput, WorkflowOnDeleteHookPayload>

export type WorkflowHookSpec<TInput extends WorkflowHookInput = WorkflowHookInput> = string | {
  function: string
  namespace?: string
  input?: TInput
}

export type WorkflowLoopMode = 'parallel' | 'sequential' | 'batch'

export interface WorkflowLoopOptions {
  /**
   * Loop execution mode:
   * - parallel (default): all items can run concurrently
   * - sequential: process one item at a time in index order
   */
  mode?: WorkflowLoopMode
  /**
   * Batch size used when mode is `batch`.
   * Defaults to 50 when omitted.
   */
  batchSize?: number
  /**
   * Per-item result storage policy for nodes declared inside this loop:
   * - memory (default): keep item results in worker memory only
   * - store: persist item results in internal workflow state
   */
  itemReturnType?: 'memory' | 'store'
  /**
   * Fanout item input transport/storage policy:
   * - memory (default): keep fanout input payloads in worker memory only
   * - store: persist fanout input payloads in internal workflow state
   */
  itemInputReturnType?: 'memory' | 'store'
}

const WORKFLOW_BRANCH = Symbol('workflow.branch')
const WORKFLOW_LOOP_ITEM = Symbol('workflow.loop.item')
const WORKFLOW_VALUE_REF = Symbol('workflow.value.ref')

export type WorkflowParallelBranch<T = any> = {
  [WORKFLOW_BRANCH]: true
  run: (ctx: WorkflowContext) => T | Promise<T>
}

export type WorkflowLoopItemRef = {
  [WORKFLOW_LOOP_ITEM]: true
}

type WorkflowValueRef = {
  [WORKFLOW_VALUE_REF]: true
  $ref: string
  $path?: string[]
  $source: 'node' | 'fanout_item'
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

function isWorkflowValueRef(value: unknown): value is WorkflowValueRef {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as any)[WORKFLOW_VALUE_REF] === true
    && typeof (value as any).$ref === 'string',
  )
}

function createWorkflowValueRef(source: 'node' | 'fanout_item', ref: string, path: string[] = []): any {
  const target: Record<string | symbol, any> = {
    [WORKFLOW_VALUE_REF]: true,
    $source: source,
    $ref: ref,
    $path: path,
    toJSON: () => ({
      [WORKFLOW_VALUE_REF]: true,
      $source: source,
      $ref: ref,
      $path: path,
    }),
  }

  if (source === 'fanout_item' && path.length === 0) {
    target[WORKFLOW_LOOP_ITEM] = true
  }

  return new Proxy(target, {
    get(obj, prop) {
      if (prop === 'then') return undefined
      if (prop in obj || typeof prop === 'symbol') {
        return (obj as any)[prop]
      }
      return createWorkflowValueRef(source, ref, [...path, String(prop)])
    },
  })
}

type CallOptions = {
  label?: string
  queue?: string
  runtime?: 'nodejs' | 'python' | 'rust' | 'unknown'
  engine_retry?: { max_attempts?: number }
  retry?: { max_attempts?: number }
  returnType?: 'memory' | 'store' | 'stream'
  streamChunkSize?: number
  onMemoryFail?: 'store' | 'error'
  inputReturnType?: 'memory' | 'store'
  inputOnMemoryFail?: 'store' | 'error'
}

type WorkflowCall = {
  <T = any>(functionId: string): Promise<T>
  <T = any>(functionId: string, input: any): Promise<T>
  <T = any>(functionId: string, input: any, options: CallOptions): Promise<T>
  <T = any>(nodeId: string, functionId: string): Promise<T>
  <T = any>(nodeId: string, functionId: string, input: any): Promise<T>
  <T = any>(nodeId: string, functionId: string, input: any, options: CallOptions): Promise<T>
}

type NodeResultOptions = {
  returnType?: 'memory' | 'store' | 'stream'
  streamChunkSize?: number
  onMemoryFail?: 'store' | 'error'
}

type NodeInputOptions = {
  returnType?: 'memory' | 'store'
  onMemoryFail?: 'store' | 'error'
}

function isCallOptions(value: unknown): value is CallOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>

  const keys = Object.keys(v)
  if (keys.length === 0) return false

  const allowedKeys = new Set([
    'label',
    'queue',
    'runtime',
    'engine_retry',
    'retry',
    'returnType',
    'streamChunkSize',
    'onMemoryFail',
    'inputReturnType',
    'inputOnMemoryFail',
  ])
  if (keys.some(key => !allowedKeys.has(key))) return false

  if ('label' in v && v.label != null && typeof v.label !== 'string') return false
  if ('queue' in v && v.queue != null && typeof v.queue !== 'string') return false
  if ('runtime' in v && v.runtime != null && !['nodejs', 'python', 'rust', 'unknown'].includes(String(v.runtime))) return false
  if ('returnType' in v && v.returnType != null && !['memory', 'store', 'stream'].includes(String(v.returnType))) return false
  if ('streamChunkSize' in v && v.streamChunkSize != null && (typeof v.streamChunkSize !== 'number' || Number.isNaN(v.streamChunkSize) || v.streamChunkSize <= 0)) return false
  if ('onMemoryFail' in v && v.onMemoryFail != null && !['store', 'error'].includes(String(v.onMemoryFail))) return false
  if ('inputReturnType' in v && v.inputReturnType != null && !['memory', 'store'].includes(String(v.inputReturnType))) return false
  if ('inputOnMemoryFail' in v && v.inputOnMemoryFail != null && !['store', 'error'].includes(String(v.inputOnMemoryFail))) return false

  const hasRetryShape = (candidate: unknown): boolean => {
    if (candidate == null) return true
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const rec = candidate as Record<string, unknown>
    if ('max_attempts' in rec && rec.max_attempts != null && typeof rec.max_attempts !== 'number') return false
    return true
  }

  if ('engine_retry' in v && !hasRetryShape(v.engine_retry)) return false
  if ('retry' in v && !hasRetryShape(v.retry)) return false

  // `label` alone is too ambiguous with normal payload objects.
  return (
    'queue' in v
    || 'runtime' in v
    || 'engine_retry' in v
    || 'retry' in v
    || 'returnType' in v
    || 'streamChunkSize' in v
    || 'onMemoryFail' in v
    || 'inputReturnType' in v
    || 'inputOnMemoryFail' in v
  )
}

function buildResultPolicy(result?: NodeResultOptions): NodeResultOptions {
  return {
    returnType: result?.returnType ?? 'memory',
    ...(result?.streamChunkSize ? { streamChunkSize: result.streamChunkSize } : {}),
    ...(result?.onMemoryFail ? { onMemoryFail: result.onMemoryFail } : {}),
  }
}

function buildInputPolicy(inputPolicy?: NodeInputOptions): NodeInputOptions {
  return {
    returnType: inputPolicy?.returnType ?? 'memory',
    ...(inputPolicy?.onMemoryFail ? { onMemoryFail: inputPolicy.onMemoryFail } : {}),
  }
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
  const lastArg = work[work.length - 1]
  const hasEmptyOptionsObject =
    work.length >= 3
    && typeof work[0] === 'string'
    && typeof work[1] !== 'string'
    && !!lastArg
    && typeof lastArg === 'object'
    && !Array.isArray(lastArg)
    && Object.keys(lastArg as Record<string, unknown>).length === 0

  if (work.length > 0 && (isCallOptions(lastArg) || hasEmptyOptionsObject)) {
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
    onStart?: WorkflowHookSpec
    onEnd?: WorkflowHookSpec
    onError?: WorkflowHookSpec
    onDelete?: WorkflowHookSpec
  }
  triggers?: TTriggers
  /** Schema for the handler input. Infers the TypeScript type and auto-extracts JSON Schema for iii. */
  input?: Parseable<TInput>
  /** Schema for the handler output. Infers the TypeScript type and auto-extracts JSON Schema for iii. */
  output?: Parseable<TOutput>
  /**
   * Input transport policy for the workflow invocation payload sent to
  * nworkflow::start (run input only).
   *
   * This does not set or override per-node inputPolicy values.
   */
  inputPolicy?: NodeInputOptions
  request_format?: Record<string, any>
  response_format?: Record<string, any>
}

function resolveWorkflowHookNamespaceDefault(): string {
  const runtimeConfig = useRuntimeConfig() as any
  const nventIii = runtimeConfig?.nvent?.iii
  const value = String(
    nventIii?.namespace?.map?.workflows
    ?? nventIii?.namespace?.default
    ?? 'default',
  ).trim()
  return value.length > 0 ? value : 'default'
}

function normalizeWorkflowHook(spec: WorkflowHookSpec | undefined, defaultNamespace: string): WorkflowHookSpec | undefined {
  if (!spec) return undefined
  if (typeof spec === 'string') {
    const fn = spec.trim()
    if (!fn) return undefined
    return {
      function: fn,
      namespace: defaultNamespace,
    }
  }

  const fn = typeof spec.function === 'string' ? spec.function.trim() : ''
  if (!fn) return undefined

  const namespace = typeof spec.namespace === 'string'
    ? spec.namespace.trim()
    : defaultNamespace
  if (!namespace) {
    throw new Error('[nvent/workflow] hook namespace must not be empty when provided.')
  }

  const normalized: WorkflowHookSpec = {
    function: fn,
    namespace,
  }

  if (spec.input && typeof spec.input === 'object' && !Array.isArray(spec.input)) {
    ;(normalized as any).input = spec.input
  }

  return normalized
}

/**
 * defineWorkflow — declares a functional DAG workflow.
 * 
 * Workflows are registered as standard iii functions. When triggered, the 
 * handler compiles the local JS workflow definition into a static DAG plan 
 * and sends it to the workflow-worker via `nworkflow::start`.
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
  const workflowInputPolicy = options.inputPolicy
    ? buildInputPolicy(options.inputPolicy)
    : undefined

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
      const hookNamespaceDefault = resolveWorkflowHookNamespaceDefault()
      const definitionCandidate: Record<string, unknown> = {
        ...plan,
        // Add workflow metadata for UI display
        metadata: {
          name: options.name,
          description: options.description,
          hooks: options.hooks ? {
            on_start: normalizeWorkflowHook(options.hooks.onStart, hookNamespaceDefault),
            on_end: normalizeWorkflowHook(options.hooks.onEnd, hookNamespaceDefault),
            on_error: normalizeWorkflowHook(options.hooks.onError, hookNamespaceDefault),
            on_delete: normalizeWorkflowHook(options.hooks.onDelete, hookNamespaceDefault),
          } : undefined,
          created_by_worker: `nvent-nodejs-${process.pid}`,
        },
      }
      const definition = serializeWorkflowDefinitionOrThrow(definitionCandidate)

      const workflowsNamespace = resolveWorkflowHookNamespaceDefault()
      const iii = useIii()
      try {
        return await iii.trigger({
          function_id: 'nworkflow::start',
          payload: {
            definition,
            input,
            ...(workflowInputPolicy ? { inputPolicy: workflowInputPolicy } : {}),
          },
          ...(workflowsNamespace ? { namespace: workflowsNamespace } : {}),
        })
      } catch (error) {
        console.error('[nvent/workflow] nworkflow::start invocation failed; definition shape summary:', {
          workflowName: options.name,
          outputFrom: (definition as any)?.output?.from,
          nodes: summarizeWorkflowDefinitionShape(definition as any),
        })
        throw error
      }
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
        const dynamicRef = (obj as { $ref?: unknown }).$ref
        const dynamicSource = (obj as { $source?: unknown }).$source
        const isValueRef = (obj as { [WORKFLOW_VALUE_REF]?: unknown })[WORKFLOW_VALUE_REF] === true

        if (typeof dynamicRef === 'string' && dynamicRef.startsWith('node:')) {
          // For value refs, only node-based refs create DAG data dependencies.
          if (!isValueRef || dynamicSource === 'node') {
            const refNodeId = dynamicRef.substring('node:'.length)
            if (refNodeId) refs.add(refNodeId)
          }
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
          const refPath = Array.isArray(items.$path)
            ? items.$path.filter((part: unknown) => typeof part === 'string' && part.length > 0)
            : []
          return refPath.length > 0
            ? `${items.$ref}.${refPath.join('.')}`
            : items.$ref
        }
        if (typeof items === 'string') {
          return items
        }
        throw new Error(`loop requires a node reference or string path, got: ${typeof items}`)
      }

      const resolveLoopMode = (options?: WorkflowLoopOptions): WorkflowLoopMode => {
        if (options?.mode === 'sequential') return 'sequential'
        if (options?.mode === 'batch') return 'batch'
        return 'parallel'
      }

      const resolveLoopBatchSize = (options?: WorkflowLoopOptions): number | undefined => {
        if (options?.mode !== 'batch') return undefined
        if (options?.batchSize == null) return 50
        if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
          throw new Error('loop options.batchSize must be a positive integer when mode is batch')
        }
        return options.batchSize
      }

      const resolveLoopItemResultReturnType = (options?: WorkflowLoopOptions): 'memory' | 'store' => {
        if (options?.itemReturnType === 'store') return 'store'
        return 'memory'
      }

      const resolveLoopItemInputReturnType = (options?: WorkflowLoopOptions): 'memory' | 'store' => {
        if (options?.itemInputReturnType === 'store') return 'store'
        return 'memory'
      }

      const applyAutoNodeSuffix = (id: string): string => {
        if (nodes[id]) return `${id}_${++autoNodeCounter}`
        return id
      }

      const toVarNodeIdBase = (key: string): string => {
        const cleaned = String(key || 'var')
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, '_')
          .replace(/^_+|_+$/g, '')
        return `var_${cleaned || 'value'}`
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
            result: buildResultPolicy(spec.result),
            ...(spec.inputPolicy ? { inputPolicy: buildInputPolicy(spec.inputPolicy) } : {}),
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

            if (!fnSpec.id || typeof fnSpec.id !== 'string') {
              throw new Error(`Invalid function id for workflow node '${id}'.`)
            }

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
          return createWorkflowValueRef('node', `node:${id}`) as any
        },
        
        call: async (...args: any[]) => {
          const parsed = parseCallArguments(args)
          const nodeId = applyAutoNodeSuffix(parsed.nodeId)
          const functionSpec = buildFunctionSpec(parsed.functionId, parsed.callOptions)
          
          return ctx.node(nodeId, {
            label: parsed.callOptions?.label,
            function: functionSpec,
            input: parsed.input,
            result: {
              returnType: parsed.callOptions?.returnType,
              streamChunkSize: parsed.callOptions?.streamChunkSize,
              onMemoryFail: parsed.callOptions?.onMemoryFail,
            },
            ...(parsed.callOptions?.inputReturnType || parsed.callOptions?.inputOnMemoryFail
              ? {
                  inputPolicy: {
                    returnType: parsed.callOptions?.inputReturnType,
                    onMemoryFail: parsed.callOptions?.inputOnMemoryFail,
                  },
                }
              : {}),
          })
        },

        var: async <T = any>(key: string, value: any, options?: { label?: string }): Promise<T> => {
          const nodeId = applyAutoNodeSuffix(toVarNodeIdBase(key))
          return ctx.node(nodeId, {
            label: options?.label ?? `var:${key}`,
            function: 'nworkflow::internal-var-set',
            input: {
              key,
              value,
            },
          })
        },

        loop: async <T = any>(items: any, fn: (loopCtx: WorkflowLoopContext) => T | Promise<T>, options?: WorkflowLoopOptions): Promise<T> => {
          const fanoutOver = resolveFanoutOver(items)
          const loopMode = resolveLoopMode(options)
          const loopBatchSize = resolveLoopBatchSize(options)
          const loopItemResultReturnType = resolveLoopItemResultReturnType(options)
          const loopItemInputReturnType = resolveLoopItemInputReturnType(options)
          const loopItemRef = createWorkflowValueRef('fanout_item', 'fanout_item') as WorkflowLoopItemRef

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
                  ...(loopMode === 'batch' ? { batchSize: loopBatchSize } : {}),
                  ...(loopItemInputReturnType !== 'memory' ? { itemReturnType: loopItemInputReturnType } : {}),
                },
                result: {
                  returnType: parsed.callOptions?.returnType ?? loopItemResultReturnType,
                  streamChunkSize: parsed.callOptions?.streamChunkSize,
                  onMemoryFail: parsed.callOptions?.onMemoryFail,
                },
                ...(parsed.callOptions?.inputReturnType || parsed.callOptions?.inputOnMemoryFail
                  ? {
                      inputPolicy: {
                        returnType: parsed.callOptions?.inputReturnType,
                        onMemoryFail: parsed.callOptions?.inputOnMemoryFail,
                      },
                    }
                  : {}),
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

