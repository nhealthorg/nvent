import { TriggerAction, type registerWorker } from 'iii-sdk'
import { trace } from '@opentelemetry/api'
import type { FunctionDef, FunctionContext, WorkflowFunctionOptions } from '../defineFunction'

type IiiClient = ReturnType<typeof registerWorker>

const WORKFLOW_STATE_SCOPE = 'workflow_run_state'
const WORKFLOW_STREAM_NAME = 'workflow'

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
  const key = (userKey: string) => `${workflow.run_id}/${userKey}`
  const stateScopeId = workflow.run_id
  const streamScopeId = workflow.run_id
  const streamSubscription = { streamName: WORKFLOW_STREAM_NAME, groupId: streamScopeId }

  return {
    stateScopeId,
    streamScopeId,
    state: {
      scopeId: stateScopeId,
      async get<T = unknown>(userKey: string): Promise<T | null> {
        const result = await iii.trigger({
          function_id: 'state::get',
          payload: { scope: WORKFLOW_STATE_SCOPE, key: key(userKey) },
          timeoutMs: 10_000,
        })
        return (result ?? null) as T | null
      },
      async set<T = unknown>(userKey: string, value: T): Promise<void> {
        await iii.trigger({
          function_id: 'state::set',
          payload: { scope: WORKFLOW_STATE_SCOPE, key: key(userKey), value },
          timeoutMs: 10_000,
          action: TriggerAction.Void()
        })
        await emitWorkflowTraceEvent(iii, functionId, workflow, 'workflow.state.set', {
          'workflow.state.key': userKey,
          'workflow.state.value': value,
        })
      },
      async delete(userKey: string): Promise<void> {
        await iii.trigger({
          function_id: 'state::delete',
          payload: { scope: WORKFLOW_STATE_SCOPE, key: key(userKey) },
          timeoutMs: 10_000,
          action: TriggerAction.Void()
        })
        await emitWorkflowTraceEvent(iii, functionId, workflow, 'workflow.state.delete', {
          'workflow.state.key': userKey,
        })
      },
      async list<T = unknown>(): Promise<Array<{ key: string, value: T }>> {
        const result = await iii.trigger({
          function_id: 'state::list',
          payload: { scope: WORKFLOW_STATE_SCOPE },
          timeoutMs: 10_000,
        })
        const values = Array.isArray(result)
          ? result
          : (result && typeof result === 'object' && 'values' in (result as any) && Array.isArray((result as any).values)
              ? (result as any).values
              : (result && typeof result === 'object'
                  ? Object.entries(result as Record<string, unknown>).map(([k, v]) => ({ key: k, value: v }))
                  : []))
        return values
          .map((item: any) => ({
            key: String(item?.key || ''),
            value: item?.value as T,
          }))
          .filter((item: { key: string }) => item.key.startsWith(`${workflow.run_id}/`))
          .map((item: { key: string, value: T }) => ({
            key: item.key.slice(workflow.run_id.length + 1),
            value: item.value,
          }))
      },
    },
    stream: {
      scopeId: streamScopeId,
      streamName: WORKFLOW_STREAM_NAME,
      groupId: streamScopeId,
      subscription() {
        return streamSubscription
      },
      async get<T = unknown>(itemId: string): Promise<T | null> {
        const result = await iii.trigger({
          function_id: 'stream::get',
          payload: { stream_name: WORKFLOW_STREAM_NAME, group_id: streamScopeId, item_id: itemId },
          timeoutMs: 10_000,
        })
        return (result ?? null) as T | null
      },
      async set(itemId: string, data: Record<string, unknown>) {
        await iii.trigger({
          function_id: 'stream::set',
          payload: { stream_name: WORKFLOW_STREAM_NAME, group_id: streamScopeId, item_id: itemId, data },
          timeoutMs: 10_000,
          action: TriggerAction.Void()
        })
      },
      async delete(itemId: string) {
        await iii.trigger({
          function_id: 'stream::delete',
          payload: { stream_name: WORKFLOW_STREAM_NAME, group_id: streamScopeId, item_id: itemId },
          timeoutMs: 10_000,
          action: TriggerAction.Void()
        })
      },
      async list<T = unknown>(): Promise<Array<{ key: string, value: T }>> {
        const result = await iii.trigger({
          function_id: 'stream::list',
          payload: { stream_name: WORKFLOW_STREAM_NAME, group_id: streamScopeId },
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
      async send(type: string, data: Record<string, unknown> = {}) {
        await iii.trigger({
          function_id: 'stream::send',
          payload: { stream_name: WORKFLOW_STREAM_NAME, group_id: streamScopeId, type, data },
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
export function registerNodeFunctions(iii: IiiClient, fns: NodeFnInfo[]): void {
  for (const fn of fns) {
    // Wrap handler to auto-emit workflow completion events
    const wrappedHandler = async (input: unknown) => {
      // Detect workflow orchestration metadata
      const isWorkflow = input && typeof input === 'object' && '_workflow' in input
      const workflow = isWorkflow ? (input as any)._workflow : null
      const hasWorkflowMeta = workflow?.run_id && workflow?.node_uid
      
      if (hasWorkflowMeta) {
        console.log(`[nvent/workflow] executing node ${workflow.node_uid} in run ${workflow.run_id} via function ${fn.id}`)
      }
      
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
            // Write error to state so orchestrator can catch it
            await iii.trigger({
              function_id: 'state::set',
              payload: {
                scope: 'workflow_node_result',
                key: `${workflow.run_id}/${workflow.node_uid}`,
                value: { __workflow_error__: errorMessage },
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
          // Write result to state
          await iii.trigger({
            function_id: 'state::set',
            payload: {
              scope: 'workflow_node_result',
              key: `${workflow.run_id}/${workflow.node_uid}`,
              value: result,
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
      iii.registerTrigger({ type: trigger.type, function_id: fn.id, config: cfg })
    }

    // Register workflow queue subscriber only when explicitly enabled via defineFunction({ workflow }).
    if (fn.workflow) {
      const queue = typeof fn.workflow === 'object' && fn.workflow.queue
        ? fn.workflow.queue
        : 'default'
      console.log(`[nvent/workflow] subscribing workflow-enabled function ${fn.id} to queue ${queue}`)
      iii.registerTrigger({
        type: 'durable:subscriber',
        function_id: fn.id,
        config: { queue },
      })
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
