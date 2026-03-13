/**
 * defineFunction — the single primitive for declaring nvent functions.
 *
 * A function bundles config (id, description, triggers, enqueues, flows)
 * and the handler in one call. The handler receives `(input, ctx)` where
 * `ctx` is a `FunctionContext` with logger, state, enqueue, and match.
 *
 * ```ts
 * export default defineFunction({
 *   id: 'orders::process',
 *   description: 'Process a placed order',
 *   triggers: [
 *     { type: 'queue', config: { topic: 'order.placed' } },
 *   ],
 *   enqueues: ['order.processed'],
 *   flows: ['orders'],
 *   handler: async (input: { orderId: string }, ctx) => {
 *     ctx.logger.info('Processing order', { orderId: input.orderId })
 *     await ctx.enqueue({ topic: 'order.processed', data: input })
 *     return { processed: true }
 *   },
 * })
 * ```
 */

import { useNitroApp } from '#imports'
import { Logger } from 'iii-sdk'

/** Internal key used to propagate the stream channel through queue messages. */
export const NVENT_STREAM_KEY = '__nventStream'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ILogger {
  info(msg: string, data?: unknown): void
  warn(msg: string, data?: unknown): void
  error(msg: string, data?: unknown): void
  debug(msg: string, data?: unknown): void
  trace(msg: string, data?: unknown): void
}

interface IState {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<{ new_value: unknown; old_value: unknown }>
  delete(key: string): Promise<void>
  update(key: string, ops: unknown[]): Promise<{ new_value: unknown; old_value: unknown }>
  list(): Promise<unknown[]>
}

/**
 * Access to the iii Stream module.
 * Data is organised as `stream_name > group_id > item_id`.
 *
 * **Implicit API** (recommended): `set(itemId, data)` automatically uses the
 * function's flow name as the stream name and a UUID that is stable for the
 * lifetime of the nvent call chain. The HTTP step activates it via
 * `subscription()` and every subsequent `enqueue()` call carries the same
 * channel info forward — no manual coordination needed.
 *
 * ```ts
 * // HTTP step — activate the channel and tell the client where to subscribe:
 * const { streamName, groupId } = ctx.stream.subscription()
 * await ctx.enqueue({ topic: 'my.topic', data: { text } })
 * return { status: 200, body: { streamName, groupId } }
 *
 * // Queue / Python step — just use set(), group ID is inherited automatically:
 * await ctx.stream.set('step-1', { label: 'Tokenizing', step: 1 })
 * await ctx.stream.send({ type: 'done' })
 * ```
 *
 * **Explicit API**: `setIn(name, group, itemId, data)` targets a specific
 * stream and group (useful for cross-flow writes).
 */
interface IStream {
  /**
   * Set (create or update) an item in the **implicit** stream channel for this
   * execution: `streamName = flow name`, `groupId = current trace ID`.
   * All WebSocket clients subscribed to that channel receive the update.
   */
  set(itemId: string, data: unknown): Promise<void>
  /**
   * Send a custom event to all subscribers of the implicit stream channel.
   * Unlike `set`, events are not persisted — they are fire-and-forget.
   */
  send(data: unknown): Promise<void>
  /**
   * Returns `{ streamName, groupId }` for the implicit stream channel.
   * Return this from an HTTP handler so the client knows where to subscribe.
   *
   * ```ts
   * return { status: 200, body: ctx.stream.subscription() }
   * ```
   */
  subscription(): { streamName: string; groupId: string }
  /**
   * Set (create or update) an item in an **explicit** stream group.
   * Use when you need to target a specific stream name and group ID.
   */
  setIn(name: string, group: string, itemId: string, data: unknown): Promise<void>
  /** Get a single item from a stream group. */
  get<T = unknown>(name: string, group: string, itemId: string): Promise<T>
  /** Delete an item from a stream group. */
  delete(name: string, group: string, itemId: string): Promise<void>
  /** List all items in a stream group. */
  list<T = unknown>(name: string, group: string): Promise<T[]>
  /** Send a custom event to all subscribers of an explicit stream group. */
  sendTo(name: string, group: string, data: unknown): Promise<void>
}

// ─── FunctionContext ──────────────────────────────────────────────────────────

/**
 * Execution context injected as the second argument to every `defineFunction` handler.
 *
 * ```ts
 * export default defineFunction({
 *   id: 'greet',
 *   triggers: [{ type: 'http', config: { api_path: 'greet', http_method: 'POST' } }],
 *   handler: async (input, ctx) => {
 *     ctx.logger.info('greet called', input)
 *     const count = await ctx.state.get('greet', 'count')
 *     await ctx.enqueue({ topic: 'greeted', data: input })
 *   },
 * })
 * ```
 */
export class FunctionContext {
  readonly logger: ILogger
  readonly state: IState
  readonly stream: IStream
  readonly triggerType: string
  private _streamName: string
  private _streamGroupId?: string

  constructor(triggerType: string, fnId: string, streamName: string, inheritedGroupId?: string) {
    this.triggerType = triggerType
    this._streamName = streamName
    this._streamGroupId = inheritedGroupId
    this.logger = new Logger(fnId, 'nvent') as unknown as ILogger
    this.state = {
      get: (key) => _iii().trigger('state::get', { scope: fnId, key }),
      set: (key, value) => _iii().trigger('state::set', { scope: fnId, key, value }) as Promise<{ new_value: unknown; old_value: unknown }>,
      delete: (key) => _iii().trigger('state::delete', { scope: fnId, key }) as Promise<void>,
      update: (key, ops) => _iii().trigger('state::update', { scope: fnId, key, ops }) as Promise<{ new_value: unknown; old_value: unknown }>,
      list: () => _iii().trigger('state::list', { scope: fnId }) as Promise<unknown[]>,
    }
    this.stream = {
      subscription: () => {
        if (!this._streamGroupId) this._streamGroupId = globalThis.crypto.randomUUID()
        return { streamName: this._streamName, groupId: this._streamGroupId }
      },
      set: (itemId, data) => {
        if (!this._streamGroupId) this._streamGroupId = globalThis.crypto.randomUUID()
        return _iii().trigger('stream::set', { stream_name: this._streamName, group_id: this._streamGroupId, item_id: itemId, data }) as Promise<void>
      },
      send: (data) => {
        if (!this._streamGroupId) this._streamGroupId = globalThis.crypto.randomUUID()
        return _iii().trigger('stream::send', { stream_name: this._streamName, group_id: this._streamGroupId, data }) as Promise<void>
      },
      // Explicit: target any stream+group
      setIn: (name, group, itemId, data) =>
        _iii().trigger('stream::set', { stream_name: name, group_id: group, item_id: itemId, data }) as Promise<void>,
      get: (name, group, itemId) =>
        _iii().trigger('stream::get', { stream_name: name, group_id: group, item_id: itemId }) as Promise<never>,
      delete: (name, group, itemId) =>
        _iii().trigger('stream::delete', { stream_name: name, group_id: group, item_id: itemId }) as Promise<void>,
      list: (name, group) =>
        _iii().trigger('stream::list', { stream_name: name, group_id: group }) as Promise<never[]>,
      sendTo: (name, group, data) =>
        _iii().trigger('stream::send', { stream_name: name, group_id: group, data }) as Promise<void>,
    }
  }

  /** Publishes a message to a queue topic.
   * If a stream channel has been activated (via `ctx.stream.subscription()` or
   * `ctx.stream.set()`), the channel info is automatically propagated to the
   * downstream step so it can write to the same stream without extra wiring.
   */
  enqueue({ topic, data }: { topic: string; data?: unknown }): Promise<void> {
    const injectData = this._streamGroupId != null
      ? { ...(typeof data === 'object' && data !== null ? data : { data }), [NVENT_STREAM_KEY]: { name: this._streamName, groupId: this._streamGroupId } }
      : data
    return _iii().trigger('enqueue', { topic, data: injectData })
  }

  /**
   * Dispatch to a trigger-type-specific handler with correctly-typed input.
   *
   * ```ts
   * handler: async (input, ctx) => ctx.match(input, {
   *   http: (req) => ({ status: 200, body: { hello: req.query_params.name } }),
   *   queue: (data) => process(data),
   *   cron: () => runSweep(),
   * })
   * ```
   */
  match<THandlers extends Partial<{
    [K in keyof TriggerInputTypeMap]: (input: TriggerInputTypeMap[K]) => unknown
  } & { default: (input: unknown) => unknown }>>(
    input: unknown,
    handlers: THandlers,
  ): unknown {
    const fn = (handlers as any)[this.triggerType] ?? (handlers as any).default
    if (!fn) throw new Error(`[nvent] ctx.match(): no handler for trigger type '${this.triggerType}'. Available: ${Object.keys(handlers).join(', ')}`)
    return fn(input)
  }
}

function _iii() {
  const nitroApp = useNitroApp()
  const iii = (nitroApp as any).$iii
  if (!iii) throw new Error('[nvent] iii SDK not initialized')
  return iii
}

// ─── HTTP request shape (Node.js workers) ────────────────────────────────────

/**
 * Input shape for http-triggered functions (Node.js).
 * The engine uses snake_case for path/query params.
 */
export interface HttpRequest {
  /** Parsed request body, or null for GET/HEAD */
  body: unknown | null
  headers: Record<string, string>
  method: string
  /** Route path as registered (e.g. 'greet') */
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

/**
 * Maps each trigger type to the input shape delivered by the engine.
 * Used to type `ctx.match()` branches and to automatically infer the handler
 * input type when all triggers share the same type.
 */
export type TriggerInputTypeMap = {
  http: HttpRequest
  cron: undefined
  queue: unknown
  state: unknown
  stream: unknown
  'stream:join': unknown
  'stream:leave': unknown
  subscribe: unknown
  log: unknown
}

export type FunctionHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  ctx: FunctionContext,
) => TOutput | Promise<TOutput>


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
  type: 'queue'
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
    /** State key to watch */
    key?: string
    /** State change event to react to */
    event?: 'set' | 'delete' | 'change'
    [key: string]: unknown
  }
}

export interface StreamTriggerConfig {
  type: 'stream'
  /** @internal injected at registration time */
  function_id?: string
  config: {
    /** Stream ID to subscribe to */
    id: string
    /** Optional filter criteria applied server-side */
    filter?: Record<string, unknown>
    [key: string]: unknown
  }
}

export interface StreamJoinTriggerConfig {
  type: 'stream:join'
  /** @internal injected at registration time */
  function_id?: string
  config: {
    /** Stream ID */
    id: string
    [key: string]: unknown
  }
}

export interface StreamLeaveTriggerConfig {
  type: 'stream:leave'
  /** @internal injected at registration time */
  function_id?: string
  config: {
    /** Stream ID */
    id: string
    [key: string]: unknown
  }
}

export interface SubscribeTriggerConfig {
  type: 'subscribe'
  /** @internal injected at registration time */
  function_id?: string
  config?: {
    /** Topic to subscribe to */
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

export type TriggerConfig =
  | HttpTriggerConfig
  | CronTriggerConfig
  | QueueTriggerConfig
  | StateTriggerConfig
  | StreamTriggerConfig
  | StreamJoinTriggerConfig
  | StreamLeaveTriggerConfig
  | SubscribeTriggerConfig
  | LogTriggerConfig

// ─── defineFunction ──────────────────────────────────────────────────────────

export interface FunctionDef<TInput = unknown, TOutput = unknown> {
  /** iii function ID (namespace::name). Auto-derived from file path if omitted. */
  id?: string
  description?: string
  triggers?: TriggerConfig[]
  /**
   * Topics this function can publish to via `ctx.enqueue()`.
   * Used by the nvent console to build flow graphs.
   */
  enqueues?: string[]
  /**
   * Flow groups this function belongs to.
   * Functions in the same flow are visualized together in the nvent console.
   */
  flows?: string[]
  /**
   * The stream name used by `ctx.stream.set()` and `ctx.stream.send()` (the
   * implicit stream channel). Defaults to `flows[0]`, or the function ID
   * prefix before `::` if no flows are declared.
   *
   * All steps that share this name and run in the same trace will write to
   * the same WebSocket channel — no manual groupId coordination needed.
   */
  stream?: string
  /** The function's business logic. Receives (input, ctx). */
  handler: FunctionHandler<TInput, TOutput>
  /** @internal — runtime marker so the registry can detect defineFunction() exports */
  readonly __nventStep: true
}

/** @internal Infers the handler input type from the declared trigger configs. */
type InferHandlerInput<TTriggers extends TriggerConfig[]> =
  [TTriggers[number]['type']] extends ['http'] ? HttpRequest : unknown

/**
 * Defines a nvent function: config + handler in one call.
 *
 * The handler input type is inferred automatically from the trigger types:
 * - http-only triggers → `input` is typed as `HttpRequest`
 * - all other triggers → `input` defaults to `unknown` (annotate explicitly)
 *
 * ```ts
 * // HTTP trigger — input inferred as HttpRequest
 * export default defineFunction({
 *   triggers: [{ type: 'http', config: { api_path: 'greet' } }],
 *   handler: async (req, ctx) => {
 *     return { body: { hello: req.query_params.name } }
 *   },
 * })
 *
 * // Queue trigger — annotate input type explicitly
 * export default defineFunction({
 *   triggers: [{ type: 'queue', config: { topic: 'order.placed' } }],
 *   handler: async (input: { orderId: string }, ctx) => { ... },
 * })
 * ```
 */
export function defineFunction<
  TTriggers extends TriggerConfig[],
  TInput = InferHandlerInput<TTriggers>,
  TOutput = unknown,
>(
  config: {
    id?: string
    description?: string
    triggers?: TTriggers
    enqueues?: string[]
    flows?: string[]
    stream?: string
    handler: FunctionHandler<TInput, TOutput>
  },
): FunctionDef<TInput, TOutput> {
  return { ...config, __nventStep: true } as FunctionDef<TInput, TOutput>
}

