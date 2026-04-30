import type { registerWorker } from 'iii-sdk'
import { FunctionContext, NVENT_STREAM_KEY } from '../defineFunction'

type IiiClient = ReturnType<typeof registerWorker>

/** Extract and strip the inherited stream context from queue message data. */
function extractStreamContext(input: unknown): { name: string; groupId: string } | undefined {
  if (typeof input === 'object' && input !== null && NVENT_STREAM_KEY in input) {
    return (input as Record<string, unknown>)[NVENT_STREAM_KEY] as { name: string; groupId: string }
  }
}

function stripStreamContext(input: unknown): unknown {
  if (typeof input === 'object' && input !== null && NVENT_STREAM_KEY in input) {
    const { [NVENT_STREAM_KEY]: _, ...rest } = input as Record<string, unknown>
    return rest
  }
  return input
}

/** Build a descriptive trigger suffix (no whitespace for valid function_id). */
function triggerSuffix(type: string, cfg: Record<string, unknown>): string {
  if (type === 'http') return `http(${cfg.http_method ?? 'GET'}_${cfg.api_path ?? '/'})`
  if (type === 'durable:subscriber') return `queue(${cfg.topic ?? ''})`
  if (type === 'cron') return `cron(${cfg.expression ?? ''})`
  return type
}

export interface NodeFnInfo {
  name: string
  description?: string
  handler: (input: unknown, ctx: FunctionContext) => Promise<unknown>
  triggers: Array<{ type: string; function_id: string; config?: Record<string, unknown> }>
  enqueues: string[]
  flows: string[]
  /** Explicit stream name for implicit ctx.stream ops. Falls back to flows[0] then name prefix. */
  stream?: string
  filePath?: string
}

/**
 * Registers all Node.js (TypeScript) functions and their triggers with the iii client.
 * Mirrors the Python side: one registration per trigger, with a validated function ID.
 */
export function registerNodeFunctions(iii: IiiClient, fns: NodeFnInfo[]): void {
  for (const fn of fns) {
    const metadata = {
      name: fn.name,
      description: fn.description,
      filePath: fn.filePath,
      triggers: (fn.triggers ?? []).map(t => {
        const cfg = t.config ?? {}
        if (t.type === 'http') return { type: 'http', path: cfg.api_path, method: cfg.http_method }
        if (t.type === 'queue') return { type: 'queue', topic: cfg.topic }
        if (t.type === 'cron') return { type: 'cron', expression: cfg.expression }
        return { type: t.type, ...cfg }
      }),
      flows: fn.flows ?? [],
      enqueues: fn.enqueues ?? [],
    }

    const seenSuffixes = new Set<string>()

    for (const [index, trigger] of (fn.triggers ?? []).entries()) {
      const cfg = trigger.config ?? {}
      // Translate nvent's user-facing 'queue' type to iii 0.11+ 'durable:subscriber'
      const iiiTriggerType = trigger.type === 'queue' ? 'durable:subscriber' : trigger.type
      let suffix = triggerSuffix(iiiTriggerType, cfg)
      if (seenSuffixes.has(suffix)) suffix = `${suffix}::${index}`
      seenSuffixes.add(suffix)

      // Motia-style function_id: steps::<name>::trigger::<descriptive-suffix>
      const function_id = `steps::${fn.name}::trigger::${suffix}`

      // Resolve the implicit stream name: explicit > first flow > name prefix
      const streamName = fn.stream ?? fn.flows?.[0] ?? fn.name.split('::')[0]
      iii.registerFunction(
        function_id,
        (input: unknown) => {
          const inherited = extractStreamContext(input)
          const cleanInput = stripStreamContext(input)
          const effectiveStream = inherited?.name ?? streamName
          return fn.handler(cleanInput, new FunctionContext(trigger.type, fn.name, effectiveStream, inherited?.groupId))
        },
        { metadata },
      )
      iii.registerTrigger({ type: iiiTriggerType, function_id, config: cfg })
    }
  }
}
