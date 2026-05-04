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
 */
export function registerNodeFunctions(iii: IiiClient, fns: NodeFnInfo[]): void {
  for (const fn of fns) {
    iii.registerFunction(
      fn.id,
      fn.handler as (input: unknown) => Promise<unknown>,
      {
        description: fn.description,
        request_format: fn.request_format,
        response_format: fn.response_format,
      },
    )

    for (const trigger of fn.triggers ?? []) {
      const cfg = trigger.config ?? {}
      iii.registerTrigger({ type: trigger.type, function_id: fn.id, config: cfg })
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
