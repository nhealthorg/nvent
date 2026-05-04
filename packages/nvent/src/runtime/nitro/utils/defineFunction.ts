/**
 * defineFunction — the single primitive for declaring nvent functions.
 *
 * A thin wrapper: the function ID is derived from the file path at
 * registration time. The handler receives raw iii input — no injected ctx.
 * Use `#nvent/server` for access to Logger, useIii, and the full iii SDK.
 *
 * ```ts
 * import { defineFunction, Logger } from '#nvent/server'
 *
 * const logger = new Logger()
 *
 * export default defineFunction({
 *   description: 'Process a placed order',
 *   triggers: [
 *     { type: 'durable:subscriber', config: { topic: 'order.placed' } },
 *   ],
 *   handler: async (input: { orderId: string }) => {
 *     logger.info('Processing order', { orderId: input.orderId })
 *     return { processed: true }
 *   },
 * })
 * ```
 */

// ─── HTTP request shape ──────────────────────────────────────────────────────

/**
 * Input shape for http-triggered functions.
 * The engine uses snake_case for path/query params.
 */
export interface HttpRequest {
  /** Parsed request body, or null for GET/HEAD */
  body: unknown | null
  headers: Record<string, string>
  method: string
  /** Route path as registered */
  path: string
  /** Path parameters extracted from the route template */
  path_params: Record<string, string>
  /** Query string parameters */
  query_params: Record<string, string>
  trigger: {
    type: 'http'
    method: string
    path: string
  }
}

// ─── Trigger config types ─────────────────────────────────────────────────────

export interface HttpTriggerConfig {
  type: 'http'
  /** @internal injected at registration time */
  function_id?: string
  config: {
    /** URL path exposed by the engine (e.g. 'greet' or '/orders/:id') */
    api_path: string
    /** HTTP method. Default: 'GET' */
    http_method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    /** Loose input schema hint — maps field names to type strings */
    input?: Record<string, string>
  }
}

export interface CronTriggerConfig {
  type: 'cron'
  /** @internal injected at registration time */
  function_id?: string
  config: {
    /** Cron expression (e.g. '0 9 * * *' for 9 AM daily) */
    expression: string
    /** Timezone for cron evaluation. Default: UTC */
    timezone?: string
  }
}

export interface QueueTriggerConfig {
  type: 'durable:subscriber'
  /** @internal injected at registration time */
  function_id?: string
  config: {
    /** Topic/queue name to consume from */
    topic: string
  }
}

export interface StateTriggerConfig {
  type: 'state'
  /** @internal injected at registration time */
  function_id?: string
  config?: {
    key?: string
    event?: 'set' | 'delete' | 'change'
    [key: string]: unknown
  }
}

export interface StreamTriggerConfig {
  type: 'stream'
  /** @internal injected at registration time */
  function_id?: string
  config: {
    id: string
    filter?: Record<string, unknown>
    [key: string]: unknown
  }
}

export interface SubscribeTriggerConfig {
  type: 'subscribe'
  /** @internal injected at registration time */
  function_id?: string
  config?: {
    topic?: string
    [key: string]: unknown
  }
}

export interface LogTriggerConfig {
  type: 'log'
  /** @internal injected at registration time */
  function_id?: string
  config?: Record<string, unknown>
}

/** Escape hatch for custom trigger types registered via `registerTriggerType()`. */
export interface CustomTriggerConfig {
  /** The custom trigger type name (e.g. 'kafka', 'mqtt', 'file-watcher'). */
  type: string
  /** @internal injected at registration time */
  function_id?: string
  config?: Record<string, unknown>
}

export type TriggerConfig =
  | HttpTriggerConfig
  | CronTriggerConfig
  | QueueTriggerConfig
  | StateTriggerConfig
  | StreamTriggerConfig
  | SubscribeTriggerConfig
  | LogTriggerConfig
  | CustomTriggerConfig

// ─── defineFunction ──────────────────────────────────────────────────────────

/** @internal Infers the handler input type from the declared trigger configs. */
type InferHandlerInput<TTriggers extends TriggerConfig[]> =
  [TTriggers[number]['type']] extends ['http'] ? HttpRequest : unknown

/** Any schema library with a parse method (Zod, Valibot, etc.) */
type Parseable<T = unknown> = { parse(data: unknown): T }

/** Infer the TypeScript type from a schema object, or fall back to Fallback. */
type InferSchema<S, Fallback = unknown> = S extends Parseable<infer T> ? T : Fallback

export type FunctionHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
) => TOutput | Promise<TOutput>

export interface FunctionDef<TInput = unknown, TOutput = unknown> {
  description?: string
  triggers?: TriggerConfig[]
  handler: FunctionHandler<TInput, TOutput>
  /** JSON Schema for the function input — registered with iii for agent/CLI discovery. */
  request_format?: Record<string, unknown>
  /** JSON Schema for the function output — registered with iii for agent/CLI discovery. */
  response_format?: Record<string, unknown>
}

/**
 * Extracts a plain JSON Schema object from a schema library instance (e.g. Zod v4).
 * Returns the value as-is if it is already a plain object without a `parse` method.
 * @internal
 */
function extractJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const s = schema as Record<string, unknown>
  if (typeof s['parse'] !== 'function') return s as Record<string, unknown> // raw JSON Schema
  if (typeof s['toJsonSchema'] === 'function') return (s['toJsonSchema'] as () => Record<string, unknown>)()
  return undefined
}

/**
 * Defines a nvent function: config + handler in one call.
 *
 * Pass Zod (or any schema-library) schemas as `input` / `output` to get:
 * - automatic TypeScript type inference for the handler arguments and return type
 * - automatic `request_format` / `response_format` extraction for iii discovery
 *
 * ```ts
 * import { z } from 'zod'
 * import { defineFunction } from '#nvent/server'
 *
 * const Input = z.object({ name: z.string() })
 * const Output = z.object({ greeting: z.string() })
 *
 * export default defineFunction({
 *   description: 'Greet someone',
 *   input: Input,   // handler input typed as { name: string }
 *   output: Output, // handler return typed as { greeting: string }
 *   triggers: [{ type: 'http', config: { api_path: '/greet', http_method: 'POST' } }],
 *   handler: async (input) => ({ greeting: `Hello ${input.name}` }),
 * })
 * ```
 *
 * Without schemas, HTTP triggers infer `HttpRequest` automatically; all others
 * default to `unknown` (annotate explicitly or use `input`).
 *
 * You may also pass raw JSON Schema objects as `request_format` / `response_format`
 * if you prefer explicit control.
 */
export function defineFunction<
  TInSchema extends Parseable<any> | undefined = undefined,
  TOutSchema extends Parseable<any> | undefined = undefined,
  TTriggers extends TriggerConfig[] = TriggerConfig[],
  TInput = TInSchema extends Parseable<infer T> ? T : InferHandlerInput<TTriggers>,
  TOutput = TOutSchema extends Parseable<infer T> ? T : unknown,
>(
  config: {
    description?: string
    /** Schema for the handler input. Infers the TypeScript type and auto-extracts JSON Schema for iii. */
    input?: TInSchema
    /** Schema for the handler output. Infers the TypeScript type and auto-extracts JSON Schema for iii. */
    output?: TOutSchema
    /** Raw JSON Schema override for the input (takes precedence over `input` extraction). */
    request_format?: Record<string, unknown>
    /** Raw JSON Schema override for the output (takes precedence over `output` extraction). */
    response_format?: Record<string, unknown>
    triggers?: TTriggers
    handler: FunctionHandler<TInput, TOutput>
  },
): FunctionDef<TInput, TOutput> {
  const { input, output, request_format, response_format, ...rest } = config
  return {
    ...rest,
    request_format: request_format ?? extractJsonSchema(input),
    response_format: response_format ?? extractJsonSchema(output),
  } as FunctionDef<TInput, TOutput>
}
