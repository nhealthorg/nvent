# Server Functions

Server functions are Node.js iii workers defined inside Nuxt. Each file under
`server/functions/` is automatically registered with the iii engine — no
manual wiring needed.

## File convention

```
server/functions/greet.ts             → greet
server/functions/orders/process.ts    → orders::process
server/functions/ml/classify.ts       → ml::classify
```

The file path (relative to `server/functions/`, without extension) maps
directly to the iii function ID. Nested directories use `::` as a separator.

Each file must export a `defineFunction(...)` call as its default export.

## `defineFunction`

`defineFunction` is the single primitive for declaring a nvent function. It is
a thin wrapper around `iii.registerFunction` + `iii.registerTrigger`.

### Minimal example

```ts
// server/functions/greet.ts
import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'Greet a user',
  triggers: [{ type: 'http', config: { api_path: '/greet', http_method: 'POST' } }],
  handler: async (data: { name: string }) => {
    return { message: `Hello, ${data.name}!` }
  },
})
```

### With Zod schemas

Pass an `input` and/or `output` schema (any library with a `.parse()` method)
to get TypeScript type inference on the handler **and** automatic JSON Schema
extraction for iii discovery/agents:

```ts
import { z } from 'zod'
import { defineFunction, Logger } from '#nvent/server'

const logger = new Logger()

const Input = z.object({
  orderId: z.string().uuid(),
  amount: z.number().positive(),
})
const Output = z.object({ invoiceId: z.string() })

export default defineFunction({
  description: 'Create an invoice for an order',
  input: Input,    // handler receives { orderId: string; amount: number }
  output: Output,  // handler must return { invoiceId: string }
  triggers: [
    { type: 'durable:subscriber', config: { topic: 'order.confirmed' } },
  ],
  handler: async (data) => {
    logger.info('Creating invoice', { orderId: data.orderId })
    // … billing logic …
    return { invoiceId: crypto.randomUUID() }
  },
})
```

Supported schema libraries: **Zod** (v3/v4), **Valibot**, **ArkType** — anything
with `.parse()` and `.toJsonSchema()`.

If you prefer raw JSON Schema, pass it directly as `request_format` /
`response_format` instead.

### API reference

| Field            | Type                       | Description                                                         |
|------------------|----------------------------|---------------------------------------------------------------------|
| `description`    | `string?`                  | Human-readable description shown in iii console and discovery       |
| `input`          | `Parseable?`               | Schema library instance. Infers handler input type + JSON Schema.   |
| `output`         | `Parseable?`               | Schema library instance. Infers handler return type + JSON Schema.  |
| `request_format` | `Record<string, unknown>?` | Raw JSON Schema for input (overrides `input` extraction).           |
| `response_format`| `Record<string, unknown>?` | Raw JSON Schema for output (overrides `output` extraction).         |
| `triggers`       | `TriggerConfig[]?`         | Trigger bindings (see below).                                       |
| `handler`        | `FunctionHandler`          | The function implementation.                                        |

## Trigger types

All built-in iii trigger types are supported. Import the config interfaces from
`#nvent/server` for IDE autocomplete.

### HTTP

The iii engine runs its own HTTP server on port 3111. nvent proxies
`/functions/**` → that port, so the function is reachable at
`/functions/greet` (matching the `api_path`).

```ts
triggers: [{ type: 'http', config: { api_path: '/greet', http_method: 'POST' } }]
```

For HTTP functions, the handler receives an `HttpRequest` object automatically
(no schema needed):

```ts
import type { HttpRequest } from '#nvent/server'

handler: async (req: HttpRequest) => {
  const { name } = req.body as { name: string }
  return { status_code: 200, body: { message: `Hello ${name}` } }
}
```

### Cron

```ts
triggers: [{ type: 'cron', config: { expression: '0 9 * * *' } }]
// also: timezone?: string
```

### Queue (durable:subscriber)

```ts
triggers: [{ type: 'durable:subscriber', config: { topic: 'order.placed' } }]
```

Publish from any handler or Nitro route:

```ts
const iii = useIii()
await iii.trigger({
  function_id: 'iii::durable::publish',
  payload: { topic: 'order.placed', data: { orderId: '123' } },
})
```

### State

```ts
triggers: [{ type: 'state', config: { scope: 'orders', key: 'status', event: 'set' } }]
```

### Stream

```ts
triggers: [{ type: 'stream', config: { id: 'pipeline' } }]
```

### PubSub

```ts
triggers: [{ type: 'subscribe', config: { topic: 'notifications' } }]
```

### Custom trigger types

For non-HTTP sources (Kafka, MQTT, file watchers), register the type in
`server/plugins/` and reference it by name:

```ts
triggers: [{ type: 'kafka', config: { topic: 'orders', groupId: 'processor' } }]
```

See [Webhooks & Custom Triggers](./webhooks-and-triggers.md) for the full setup.

## Using `useIii()` inside handlers

The raw iii SDK instance is available everywhere via `useIii()`:

```ts
import { defineFunction, Logger } from '#nvent/server'

const logger = new Logger()

export default defineFunction({
  triggers: [{ type: 'cron', config: { expression: '0 * * * * * *' } }],
  handler: async () => {
    const iii = useIii()

    // Read state
    const last = await iii.trigger({
      function_id: 'state::get',
      payload: { scope: 'cron', key: 'lastRun' },
    })

    // Write state
    await iii.trigger({
      function_id: 'state::set',
      payload: { scope: 'cron', key: 'lastRun', value: Date.now() },
    })

    // Enqueue work
    await iii.trigger({
      function_id: 'iii::durable::publish',
      payload: { topic: 'cron.tick', data: { prev: last } },
    })

    logger.info('Cron ticked')
  },
})
```

## Standalone trigger registration

Triggers can also be registered outside `defineFunction` — useful when the
same function needs triggers added from multiple places:

```ts
// server/plugins/extra-triggers.ts
export default defineNitroPlugin(() => {
  const iii = useIii()
  iii.registerTrigger({
    type: 'durable:subscriber',
    function_id: 'orders::process',
    config: { topic: 'order.placed' },
  })
})
```

## Logging

`Logger` is re-exported from `#nvent/server` — one import, OTel context
propagated automatically:

```ts
import { Logger } from '#nvent/server'
const logger = new Logger()
logger.info('hello', { orderId: '123' })
logger.warn('slow query', { ms: 420 })
logger.error('failed', { err })
```

## Layer support

nvent scans `server/functions/` in every Nuxt layer. Functions in layers are
prefixed with the layer name to avoid ID collisions:

```
# root project
server/functions/greet.ts           → greet

# layer with $meta.name = 'auth'
server/functions/login.ts           → auth::login
```

To set a custom prefix, add `nvent.functions.prefix` to the layer's `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  nvent: { functions: { prefix: 'myorg::auth' } },
})
```

## Hot reload (dev)

Saving a function file triggers nvent's file watcher to re-scan `server/functions/`
and Nitro's HMR to re-execute the module. The updated handler and triggers are
live immediately — no Nitro restart required.
