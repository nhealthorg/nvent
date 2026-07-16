import type { registerWorker } from 'iii-sdk'
import type { FunctionDef } from '../defineFunction'

type IiiClient = ReturnType<typeof registerWorker>

export interface NodeFnInfo {
  /** iii function ID (e.g. 'greet' or 'orders::process') */
  id: string
  description?: string
  handler: (input: unknown) => Promise<unknown> | unknown
  triggers: Array<{ type: string; function_id?: string; config?: Record<string, unknown> }>
  /** JSON Schema for input — passed to iii for agent/CLI discovery. */
  request_format?: Record<string, unknown>
  /** JSON Schema for output — passed to iii for agent/CLI discovery. */
  response_format?: Record<string, unknown>
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
      
      // Execute handler with unwrapped input
      let result: any
      try {
        result = await fn.handler(actualInput)
      } catch (err: any) {
        const errorMessage = err?.message || String(err)
        console.error(`[nvent/workflow] node ${workflow.node_uid} in run ${workflow.run_id} failed:`, errorMessage)

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
          console.log(`[nvent/workflow] node ${workflow.node_uid} completed, writing result and emitting event`)
          
          // Write result to state
          await iii.trigger({
            function_id: 'state::set',
            payload: {
              scope: 'workflow_node_result',
              key: `${workflow.run_id}/${workflow.node_uid}`,
              value: result,
            },
          })
          
          console.log(`[nvent/workflow] result written to state for ${workflow.node_uid}`)
          
          // Emit completion event (fast-path tick wake)
          await iii.trigger({
            function_id: 'workflow::node-completed',
            payload: {
              run_id: workflow.run_id,
              node_uid: workflow.node_uid,
            },
          })
          
          console.log(`[nvent/workflow] completion event emitted for ${workflow.node_uid}`)
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

    // Auto-register triggerless functions as subscribers to "default" queue
    // so they can be called asynchronously by the workflow orchestrator
    if (!fn.triggers || fn.triggers.length === 0) {
      console.log(`[nvent/workflow] auto-subscribing triggerless function ${fn.id} to default queue`)
      iii.registerTrigger({
        type: 'durable:subscriber',
        function_id: fn.id,
        config: { queue: 'default' },
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
  }
}
