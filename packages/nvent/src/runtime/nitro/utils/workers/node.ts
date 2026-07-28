import { TriggerAction, type registerWorker } from 'iii-sdk'
import { trace } from '@opentelemetry/api'
import type { FunctionDef, FunctionContext, WorkflowFunctionOptions } from '../defineFunction'

type IiiClient = ReturnType<typeof registerWorker>

const WORKFLOW_STATE_SCOPE = 'workflow_run_state'
const WORKFLOW_STREAM_NAME = 'workflow'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isTransientTriggerRegistrationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /worker\s+.+\s+is\s+missing|trigger\s+type\s+.+\s+not\s+found|not\s+active\s+in\s+your\s+project/i.test(msg)
}

function extractWorkerNameStatus(entry: unknown): { name?: string, status?: string } {
  if (typeof entry === 'string') return { name: entry, status: 'unknown' }
  if (!entry || typeof entry !== 'object') return {}
  const raw = entry as Record<string, unknown>
  const name = raw.name ?? raw.worker ?? raw.id
  const status = raw.status ?? raw.state
  return {
    name: typeof name === 'string' ? name : undefined,
    status: typeof status === 'string' ? status : undefined,
  }
}

function isWorkerReadyStatus(status?: string): boolean {
  if (!status) return true
  return ['running', 'ready', 'active', 'connected', 'ok', 'unknown', 'available'].includes(status.toLowerCase())
}

function normalizeTriggerTypeEntry(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry
  if (!entry || typeof entry !== 'object') return undefined
  const raw = entry as Record<string, unknown>
  const type = raw.type ?? raw.trigger_type ?? raw.name ?? raw.id
  return typeof type === 'string' ? type : undefined
}

function asArrayPayload(result: unknown, key: 'workers' | 'triggers'): unknown[] {
  if (Array.isArray(result)) return result
  if (result && typeof result === 'object') {
    const value = (result as Record<string, unknown>)[key]
    if (Array.isArray(value)) return value
  }
  return []
}

async function waitForRequiredWorkers(
  iii: IiiClient,
  requiredWorkers: Set<string>,
  options?: { timeoutMs?: number, pollMs?: number },
): Promise<void> {
  if (requiredWorkers.size === 0) return
  const timeoutMs = options?.timeoutMs ?? 25_000
  const pollMs = options?.pollMs ?? 400
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const result = await iii.trigger({
        function_id: 'engine::workers::list',
        payload: {},
        timeoutMs: 5_000,
      })
      const running = new Set<string>()
      for (const entry of asArrayPayload(result, 'workers')) {
        const { name, status } = extractWorkerNameStatus(entry)
        if (!name) continue
        if (isWorkerReadyStatus(status)) running.add(name)
      }
      const missing = Array.from(requiredWorkers).filter(name => !running.has(name))
      if (missing.length === 0) return
    }
    catch {
      // Engine inventory endpoint can fail briefly while modules are still initializing.
    }
    await sleep(pollMs)
  }

  const missing = Array.from(requiredWorkers).join(', ')
  console.warn(`[nvent] worker readiness timeout before registration: ${missing}`)
}

async function waitForRequiredTriggerTypes(
  iii: IiiClient,
  requiredTriggerTypes: Set<string>,
  options?: { timeoutMs?: number, pollMs?: number },
): Promise<void> {
  if (requiredTriggerTypes.size === 0) return
  const timeoutMs = options?.timeoutMs ?? 25_000
  const pollMs = options?.pollMs ?? 400
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const result = await iii.trigger({
        function_id: 'engine::triggers::list',
        payload: {},
        timeoutMs: 5_000,
      })
      const available = new Set<string>()
      for (const entry of asArrayPayload(result, 'triggers')) {
        const triggerType = normalizeTriggerTypeEntry(entry)
        if (triggerType) available.add(triggerType)
      }
      const missing = Array.from(requiredTriggerTypes).filter(type => !available.has(type))
      if (missing.length === 0) return
    }
    catch {
      // Trigger catalog endpoint can fail briefly while engine starts.
    }
    await sleep(pollMs)
  }

  const missing = Array.from(requiredTriggerTypes).join(', ')
  console.warn(`[nvent] trigger-type readiness timeout before registration: ${missing}`)
}

async function registerTriggerWithRetry(
  iii: IiiClient,
  trigger: { type: string, function_id: string, config: Record<string, unknown> },
  options?: { maxAttempts?: number, initialDelayMs?: number },
): Promise<void> {
  const maxAttempts = options?.maxAttempts ?? 25
  const initialDelayMs = options?.initialDelayMs ?? 200

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await iii.registerTrigger(trigger)
      return
    }
    catch (err) {
      if (!isTransientTriggerRegistrationError(err) || attempt >= maxAttempts) {
        throw err
      }
      const backoffMs = Math.min(initialDelayMs * Math.pow(1.35, attempt - 1), 3_000)
      await sleep(backoffMs)
    }
  }
}

async function registerWorkflowQueueSubscriber(
  iii: IiiClient,
  functionId: string,
  queue: string,
): Promise<void> {
  const maxAttempts = 40
  const initialDelayMs = 250

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await iii.trigger({
        function_id: 'engine::register_trigger',
        payload: {
          trigger_type: 'durable:subscriber',
          function_id: functionId,
          config: { queue },
        },
        timeoutMs: 10_000,
      })
      return
    }
    catch (err) {
      if (!isTransientTriggerRegistrationError(err) || attempt >= maxAttempts) {
        throw err
      }
      const backoffMs = Math.min(initialDelayMs * Math.pow(1.35, attempt - 1), 3_000)
      await sleep(backoffMs)
    }
  }
}

export interface NodeFnInfo {
  /** iii function ID (e.g. 'greet' or 'orders::process') */
  id: string
  description?: string
  handler: (input: unknown, context: FunctionContext) => Promise<unknown> | unknown
  triggers: Array<{ type: string; function_id?: string; config?: Record<string, unknown> }>
  /** JSON Schema for input — passed to iii for agent/CLI discovery. */
  request_format?: Record<string, unknown>
  /** JSON Schema for output — passed to iii for agent/CLI discovery. */
  response_format?: Record<string, unknown>
  workflow?: boolean | WorkflowFunctionOptions
}

function makeRecordId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function createWorkflowScopedContext(
  iii: IiiClient,
  functionId: string,
  workflow: { run_id: string, node_uid: string },
) {
  return {
    stateScopeId: workflow.run_id,
    streamScopeId: workflow.run_id,
    state: {
      scopeId: workflow.run_id,
      async get<T = unknown>(userKey: string): Promise<T | null> {
        const result = await iii.trigger({
          function_id: 'workflow::state-get',
          payload: { run_id: workflow.run_id, key: userKey },
          timeoutMs: 10_000,
        })
        return (result ?? null) as T | null
      },
      async set<T = unknown>(userKey: string, value: T): Promise<void> {
        await iii.trigger({
          function_id: 'workflow::state-set',
          payload: {
            run_id: workflow.run_id,
            key: userKey,
            value,
            node_uid: workflow.node_uid
          },
          timeoutMs: 10_000,
          action: TriggerAction.Void()
        })
      },
      async delete(userKey: string): Promise<void> {
        await iii.trigger({
          function_id: 'workflow::state-delete',
          payload: {
            run_id: workflow.run_id,
            key: userKey,
            node_uid: workflow.node_uid
          },
          timeoutMs: 10_000,
          action: TriggerAction.Void()
        })
      },
      async list<T = unknown>(): Promise<Array<{ key: string, value: T }>> {
        const result = await iii.trigger({
          function_id: 'workflow::state-list',
          payload: { run_id: workflow.run_id },
          timeoutMs: 10_000,
        })
        return (result || []) as Array<{ key: string, value: T }>
      },
    },
    stream: {
      scopeId: workflow.run_id,
      streamName: WORKFLOW_STREAM_NAME,
      groupId: workflow.run_id,
      subscription() {
        return { streamName: WORKFLOW_STREAM_NAME, groupId: workflow.run_id }
      },
      async get<T = unknown>(itemId: string): Promise<T | null> {
        const result = await iii.trigger({
          function_id: 'stream::get',
          payload: { stream_name: WORKFLOW_STREAM_NAME, group_id: workflow.run_id, item_id: itemId },
          timeoutMs: 10_000,
        })
        return (result ?? null) as T | null
      },
      async set(itemId: string, data: Record<string, unknown>) {
        await iii.trigger({
          function_id: 'stream::set',
          payload: { stream_name: WORKFLOW_STREAM_NAME, group_id: workflow.run_id, item_id: itemId, data },
          timeoutMs: 10_000,
          action: TriggerAction.Void()
        })
      },
      async delete(itemId: string) {
        await iii.trigger({
          function_id: 'stream::delete',
          payload: { stream_name: WORKFLOW_STREAM_NAME, group_id: workflow.run_id, item_id: itemId },
          timeoutMs: 10_000,
          action: TriggerAction.Void()
        })
      },
      async list<T = unknown>(): Promise<Array<{ key: string, value: T }>> {
        const result = await iii.trigger({
          function_id: 'stream::list',
          payload: { stream_name: WORKFLOW_STREAM_NAME, group_id: workflow.run_id },
          timeoutMs: 10_000,
        })
        const raw = Array.isArray(result)
          ? result
          : (result && typeof result === 'object' && Array.isArray((result as any).values)
              ? (result as any).values
              : (result && typeof result === 'object'
                  ? Object.entries(result as Record<string, unknown>).map(([k, v]) => ({ key: k, value: v }))
                  : []))
        return raw
          .map((item: any) => ({
            key: String(item?.key || item?.id || ''),
            value: (item?.value ?? item?.data ?? item) as T,
          }))
          .filter((item: { key: string }) => Boolean(item.key))
      },
      async publish(streamName: string, data: any) {
        await iii.trigger({
          function_id: 'workflow::stream-publish',
          payload: {
            run_id: workflow.run_id,
            stream: streamName,
            data,
            node_uid: workflow.node_uid
          },
          timeoutMs: 10_000,
          action: TriggerAction.Void()
        })
      },
      // Keep legacy send for compatibility, but map it to publish if possible
      async send(type: string, data: Record<string, unknown> = {}) {
        await iii.trigger({
          function_id: 'workflow::stream-publish',
          payload: {
            run_id: workflow.run_id,
            stream: type,
            data,
            node_uid: workflow.node_uid,
          },
          timeoutMs: 10_000,
          action: TriggerAction.Void()
        })
      },
    },
  }
}

async function emitWorkflowTraceEvent(
  iii: IiiClient,
  functionId: string,
  workflow: { run_id: string, node_uid: string, trace_id?: string },
  eventName: 'workflow.node.started' | 'workflow.node.completed' | 'workflow.node.failed' | 'workflow.state.set' | 'workflow.state.delete',
  attributes?: Record<string, unknown>,
) {
  const activeSpan = trace.getActiveSpan()
  const spanContext = activeSpan?.spanContext()
  const traceId = workflow.trace_id ?? spanContext?.traceId
  const spanId = spanContext?.spanId
  const tsUnixMs = Date.now()
  const eventAttrs: Record<string, unknown> = {
    'iii.function.id': functionId,
    'workflow.node_uid': workflow.node_uid,
    'workflow.run_id': workflow.run_id,
    'workflow.runtime': 'nodejs',
    ...(attributes || {}),
  }

  activeSpan?.addEvent(eventName, eventAttrs as any)

  try {
    await iii.trigger({
      function_id: 'workflow::trace-write',
      payload: {
        run_id: workflow.run_id,
        id: makeRecordId('trace'),
        node_uid: workflow.node_uid,
        function_id: functionId,
        runtime: 'nodejs',
        event_name: eventName,
        ts_unix_ms: tsUnixMs,
        attributes: eventAttrs,
        trace_id: traceId,
        span_id: spanId,
      },
      timeoutMs: 10_000,
    })
  } catch (err) {
    console.error(`[nvent/workflow] failed to write trace event ${eventName} for ${functionId}:`, err)
  }
}

function createContextLogger(iii: IiiClient, functionId: string, context: { run_id?: string, node_uid?: string, trace_id?: string }) {
  const pendingWrites = new Set<Promise<unknown>>()

  const activeSpanContext = () => trace.getActiveSpan()?.spanContext()

  const emit = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => {
    const tsUnixMs = Date.now()

    const spanContext = activeSpanContext()
    const traceId = context.trace_id ?? (spanContext?.traceId || undefined)
    const spanId = spanContext?.spanId

    const structuredData = {
      ...(data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : (data !== undefined ? { value: data } : {})),
      level,
      'iii.function.id': functionId,
      ...(context.run_id ? { 'workflow.run_id': context.run_id } : {}),
      ...(context.node_uid ? { 'workflow.node_uid': context.node_uid } : {}),
      ...(traceId ? { trace_id: traceId } : {}),
      ...(spanId ? { span_id: spanId } : {}),
    }

    const write = (context.run_id
      ? iii.trigger({
          function_id: 'workflow::log-write',
          payload: {
            run_id: context.run_id,
            id: makeRecordId('log'),
            node_uid: context.node_uid,
            function_id: functionId,
            runtime: 'nodejs',
            level,
            message,
            ts_unix_ms: tsUnixMs,
            data: structuredData,
          },
          timeoutMs: 10_000,
        })
      : iii.trigger({
          function_id: `engine::log::${level === 'debug' ? 'info' : level}`,
          payload: {
            message,
            service_name: 'nvent',
            ...(traceId ? { trace_id: traceId } : {}),
            ...(spanId ? { span_id: spanId } : {}),
            data: structuredData,
          },
          timeoutMs: 10_000,
        })
    ).catch((err) => {
      console.error(`[nvent/logger] failed to emit ${level} log for ${functionId}:`, err)
    }).finally(() => {
      pendingWrites.delete(write)
    })

    pendingWrites.add(write)
  }

  return {
    logger: {
      debug: (message: string, data?: unknown) => emit('debug', message, data),
      info: (message: string, data?: unknown) => emit('info', message, data),
      warn: (message: string, data?: unknown) => emit('warn', message, data),
      error: (message: string, data?: unknown) => emit('error', message, data),
    },
    flush: async () => {
      if (pendingWrites.size === 0) return
      await Promise.allSettled(Array.from(pendingWrites))
    },
  }
}

/**
 * Registers all Node.js (TypeScript) functions and their triggers with the iii client.
 * Each trigger is registered independently with the function ID as the target.
 * 
 * Auto-wraps handlers to emit workflow::node-completed events when _workflow metadata
 * is present in the input (workflow orchestration).
 */
export async function registerNodeFunctions(iii: IiiClient, fns: NodeFnInfo[]): Promise<void> {
  const requiredWorkers = new Set<string>()
  const requiredTriggerTypes = new Set<string>()

  for (const fn of fns) {
    for (const trigger of fn.triggers ?? []) {
      if (trigger.type === 'http') requiredWorkers.add('iii-http')
      if (trigger.type === 'cron') requiredWorkers.add('iii-cron')
      if (trigger.type === 'durable:subscriber') requiredWorkers.add('queue')
      requiredTriggerTypes.add(trigger.type)
    }
    if (fn.workflow) {
      requiredWorkers.add('queue')
      requiredTriggerTypes.add('durable:subscriber')
    }
  }

  await waitForRequiredWorkers(iii, requiredWorkers)
  await waitForRequiredTriggerTypes(iii, requiredTriggerTypes)

  for (const fn of fns) {
    // Wrap handler to auto-emit workflow completion events
    const wrappedHandler = async (input: unknown) => {
      // Detect workflow orchestration metadata
      const isWorkflow = input && typeof input === 'object' && '_workflow' in input
      const workflow = isWorkflow ? (input as any)._workflow : null
      const hasWorkflowMeta = workflow?.run_id && workflow?.node_uid
      
      
      // Extract actual input (unwrap from workflow envelope)
      const actualInput = hasWorkflowMeta && 'input' in (input as any)
        ? (input as any).input
        : input
      
      // Initialize context and logger
      const loggerContext = {
        run_id: hasWorkflowMeta ? workflow.run_id : undefined,
        node_uid: hasWorkflowMeta ? workflow.node_uid : undefined,
        trace_id: hasWorkflowMeta ? workflow.trace_id : undefined,
      }
      const contextLogger = createContextLogger(iii, fn.id, loggerContext)
      const context: FunctionContext = { logger: contextLogger.logger }

      if (hasWorkflowMeta) {
        context.run_id = workflow.run_id
        context.node_uid = workflow.node_uid
        context.trace_id = workflow.trace_id
        context.workflow = createWorkflowScopedContext(iii, fn.id, {
          run_id: workflow.run_id,
          node_uid: workflow.node_uid,
        })
        const activeSpan = trace.getActiveSpan()
        activeSpan?.setAttribute('workflow.run_id', workflow.run_id)
        activeSpan?.setAttribute('workflow.node_uid', workflow.node_uid)
        activeSpan?.setAttribute('iii.function.id', fn.id)
        activeSpan?.setAttribute('workflow.runtime', 'nodejs')
        if (workflow.trace_id) {
          activeSpan?.setAttribute('workflow.trace_id', workflow.trace_id)
        }
        await emitWorkflowTraceEvent(iii, fn.id, workflow, 'workflow.node.started')
      }

      // Execute handler with unwrapped input and context
      let result: any
      try {
        result = await fn.handler(actualInput, context)
        await contextLogger.flush()
      } catch (err: any) {
        const errorMessage = err?.message || String(err)
        if (hasWorkflowMeta) {
          await emitWorkflowTraceEvent(iii, fn.id, workflow, 'workflow.node.failed', {
            error: errorMessage,
          })
        }
        await contextLogger.flush()

        if (hasWorkflowMeta) {
          try {
            // Write error result to workflow internal state
            await iii.trigger({
              function_id: 'workflow::node-result-write',
              payload: {
                run_id: workflow.run_id,
                node_uid: workflow.node_uid,
                result: { __workflow_error__: errorMessage },
              },
            })

            // Emit completion event to wake the orchestrator
            await iii.trigger({
              function_id: 'workflow::node-completed',
              payload: {
                run_id: workflow.run_id,
                node_uid: workflow.node_uid,
                trace_id: trace.getActiveSpan()?.spanContext().traceId,
                function_id: fn.id,
                runtime: 'nodejs',
              },
            })
          } catch (reportErr) {
            console.error(`[nvent/workflow] failed to report node failure for ${workflow.node_uid}:`, reportErr)
          }
        }
        throw err
      }
      
      // Auto-emit workflow completion if this is a workflow node execution
      if (hasWorkflowMeta) {
        try {
          await emitWorkflowTraceEvent(iii, fn.id, workflow, 'workflow.node.completed')
          // Write result to workflow internal state
          await iii.trigger({
            function_id: 'workflow::node-result-write',
            payload: {
              run_id: workflow.run_id,
              node_uid: workflow.node_uid,
              result,
            },
          })
          
          // Emit completion event (fast-path tick wake)
          await iii.trigger({
            function_id: 'workflow::node-completed',
            payload: {
              run_id: workflow.run_id,
              node_uid: workflow.node_uid,
              trace_id: trace.getActiveSpan()?.spanContext().traceId,
              function_id: fn.id,
              runtime: 'nodejs',
            },
          })
          
        } catch (err) {
          // Log but don't throw - result is still returned
          console.error(`[nvent/workflow] completion failed for ${workflow.node_uid}:`, err)
        }
      }
      
      return result
    }

    iii.registerFunction(
      fn.id,
      wrappedHandler,
      {
        description: fn.description,
        request_format: fn.request_format,
        response_format: fn.response_format,
      },
    )

    // Register all declared triggers
    for (const trigger of fn.triggers ?? []) {
      const cfg = trigger.config ?? {}
      await registerTriggerWithRetry(iii, { type: trigger.type, function_id: fn.id, config: cfg })
    }

    // Register workflow queue subscriber only when explicitly enabled via defineFunction({ workflow }).
    if (fn.workflow) {
      const queue = typeof fn.workflow === 'object' && fn.workflow.queue
        ? fn.workflow.queue
        : 'default'
      console.log(`[nvent/workflow] subscribing workflow-enabled function ${fn.id} to queue ${queue}`)
      await registerWorkflowQueueSubscriber(iii, fn.id, queue)
    }
  }
}

/**
 * Normalizes a raw module namespace (from a dynamic import of a function file)
 * into a NodeFnInfo object.
 *
 * Convention: every function file must default-export a `defineFunction()` result.
 * The file-path-derived ID is always authoritative.
 */
export function normalizeModuleToFnInfo(ns: Record<string, unknown>, fallbackId: string, absPath: string): NodeFnInfo | null {
  const def = ns.default as FunctionDef | undefined

  if (!def || typeof def.handler !== 'function') return null

  const id = fallbackId
  const triggers = (def.triggers ?? []).map(t => ({ ...t, function_id: id }))

  return {
    id,
    description: def.description,
    handler: def.handler as (input: unknown) => Promise<unknown> | unknown,
    triggers,
    request_format: def.request_format,
    response_format: def.response_format,
    workflow: def.workflow,
  }
}
