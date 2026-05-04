# Nvent

Nvent is a Nuxt module for building event-driven backend workflows. Functions are declared in `server/functions/`, auto-discovered at startup, and wired to triggers (HTTP, queue, cron, stream, state change). A persistent orchestration engine runs alongside your Nuxt server and handles scheduling, state, queuing, and real-time streams. Nvent provides the TypeScript and Python APIs and Nuxt integration on top of it.

## Installation

```bash
npm install nvent

# Optional: monitoring UI
npm install @nvent-addon/app
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nvent'],
})
```

No further config is required to get started. The engine binary is downloaded automatically on first `nuxt dev`.

## Functions

Each file in `server/functions/` that exports a `defineFunction()` default is registered as a function. The function ID is derived from the file path (e.g. `server/functions/orders/process.ts` → `orders::process`).

The handler receives raw input from the engine — there is no injected context argument. Use `Logger` and `useIii()` from `#nvent/server` instead.

```ts
// server/functions/orders/process.ts
import { defineFunction, useIii } from '#nvent/server'
import { Logger } from 'iii-sdk'

const logger = new Logger()

export default defineFunction({
  description: 'Process a placed order',
  triggers: [{ type: 'durable:subscriber', config: { topic: 'order.placed' } }],
  handler: async (input: { orderId: string }) => {
    logger.info('Processing order', { orderId: input.orderId })
    return { processed: true }
  },
})
```

### Trigger types

| Type | Description |
|---|---|
| `http` | Exposes an HTTP endpoint via the engine's REST API |
| `durable:subscriber` | Consumes messages from a durable topic |
| `cron` | Runs on a cron schedule |
| `state` | Fires when a state key is set, changed, or deleted |
| `stream` | Fires on stream updates or when clients join/leave |
| `subscribe` | General pub/sub subscription |

```ts
// HTTP trigger — input is typed as HttpRequest automatically
export default defineFunction({
  triggers: [{ type: 'http', config: { api_path: 'greet', http_method: 'GET' } }],
  handler: async (req) => {
    const name = req.query_params?.name ?? 'world'
    return { status: 200, body: { hello: name } }
  },
})

// Cron trigger
export default defineFunction({
  triggers: [{ type: 'cron', config: { expression: '0 9 * * *' } }],
  handler: async () => {
    await runDailyReport()
  },
})
```

### Input schemas

Pass a Zod (or any `.parse()`-compatible) schema as `input` to get typed handler arguments and automatic JSON Schema extraction for iii discovery:

```ts
import { z } from 'zod'
import { defineFunction } from '#nvent/server'
import { Logger } from 'iii-sdk'

const logger = new Logger()

const Input = z.object({ orderId: z.string().uuid(), amount: z.number().positive() })
const Output = z.object({ invoiceId: z.string() })

export default defineFunction({
  description: 'Create an invoice for an order',
  input: Input,   // handler receives { orderId: string; amount: number }
  output: Output, // handler must return { invoiceId: string }
  triggers: [{ type: 'durable:subscriber', config: { topic: 'order.confirmed' } }],
  handler: async (data) => {
    logger.info('Creating invoice', { orderId: data.orderId })
    return { invoiceId: await createInvoice(data) }
  },
})
```

### Triggering other functions

Use `useIii()` from `#nvent/server` to dispatch to other functions or engine built-ins:

```ts
import { defineFunction, useIii } from '#nvent/server'

export default defineFunction({
  triggers: [{ type: 'http', config: { api_path: 'pipeline/start', http_method: 'POST' } }],
  handler: async (req) => {
    const iii = useIii()
    await iii.trigger({
      function_id: 'iii::durable::publish',
      payload: { topic: 'pipeline.analyze', data: req.body },
    })
    return { status: 200, body: { ok: true } }
  },
})
```

## Python functions

Python functions are supported alongside TypeScript. Place `.py` files in `server/functions/` following the same naming convention (e.g. `server/functions/analyze.py` → `analyze`).

Configure the Python interpreter in `nuxt.config.ts`:

```ts
nvent: {
  functions: {
    python: { devPath: '.venv/bin/python3' },
  },
}
```

In production, set the `NVENT_PYTHON_BIN` environment variable instead.

Install the iii Python SDK in your venv:

```bash
pip install iii-sdk
```

### Python API

Python functions use `define_function()` with trigger helpers (`http()`, `queue()`, `cron()`). The handler receives an `ApiRequest` for HTTP triggers or a plain `dict` for queue/cron:

```python
# server/functions/greet.py
from nvent import define_function, http, ApiRequest, ApiResponse, Logger

logger = Logger("greet")

async def handler(req: ApiRequest) -> ApiResponse:
    name = req.query_params.get("name", "World")
    logger.info("greet called", {"name": name})
    return ApiResponse(statusCode=200, body={"hello": name})

define_function(
    description="Returns a greeting",
    triggers=[http("GET", "/greet")],
    handler=handler,
)
```

```python
# server/functions/orders/notify.py
from nvent import define_function, queue, FlowContext

async def handler(data: dict, ctx: FlowContext) -> None:
    await ctx.stream.set("notify", {"status": "sent", "orderId": data["orderId"]})

define_function(
    triggers=[queue("order.processed")],
    handler=handler,
)
```

```python
# server/functions/report.py
from nvent import define_function, cron, FlowContext

async def handler(ctx: FlowContext) -> None:
    await run_daily_report()

define_function(
    triggers=[cron("0 0 9 * * * *")],
    handler=handler,
)
```

**`ApiRequest` fields** (HTTP triggers):

| Field | Type | Description |
|---|---|---|
| `query_params` | `dict[str, str]` | URL query parameters |
| `path_params` | `dict[str, str]` | Path parameters |
| `body` | `Any` | Parsed request body |
| `headers` | `dict[str, str]` | Request headers |
| `method` | `str` | HTTP method |

**`ApiResponse` constructor**:

```python
ApiResponse(statusCode=200, body={"ok": True}, headers={"x-request-id": rid})
```

### IDE support

When `functions.python.devPath` is set, nvent automatically:
- Installs `nvent.py` into your venv's `site-packages` for `from nvent import ...` resolution
- Writes `pyrightconfig.json` in your project root so Pylance and pyright resolve types without manual configuration

## Flows

Functions that share a `flows` name are grouped into a flow and visualized together in the UI. A flow is defined implicitly: there is no separate flow declaration file.

```ts
// server/functions/checkout/validate.ts
import { defineFunction, useIii } from '#nvent/server'

export default defineFunction({
  flows: ['checkout'],
  triggers: [{ type: 'durable:subscriber', config: { topic: 'checkout.started' } }],
  enqueues: ['checkout.validated'],
  handler: async (input) => {
    await validate(input)
    const iii = useIii()
    await iii.trigger({ function_id: 'iii::durable::publish', payload: { topic: 'checkout.validated', data: input } })
  },
})

// server/functions/checkout/charge.ts
export default defineFunction({
  flows: ['checkout'],
  triggers: [{ type: 'durable:subscriber', config: { topic: 'checkout.validated' } }],
  handler: async (input) => {
    await charge(input)
  },
})
```

The `enqueues` field is metadata only — it tells the UI which topics a function produces so the flow graph can be rendered without running any code.

## Configuration

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nvent'],

  nvent: {
    iii: {
      // Engine version to install. Default: 'latest'
      version: 'latest',

      // 'local'  — nvent manages the binary lifecycle (default for dev)
      // 'docker' — engine runs in Docker, nvent does not manage it
      // 'remote' — engine is hosted elsewhere, nvent only connects
      mode: 'local',

      // Queue module
      queue: {
        adapter: { type: 'builtin', storeMethod: 'in_memory' },
        queueConfigs: {
          orders: { concurrency: 5, maxRetries: 3 },
          emails: { concurrency: 2 },
        },
      },

      // State module
      state: {
        adapter: { type: 'kv', storeMethod: 'file_based', filePath: '.data/state' },
      },

      // Observability (OTel)
      observability: {
        enabled: true,
        logsEnabled: true,
        logsExporter: 'memory',  // queryable in the UI
        exporter: 'memory',
      },

      // Log level for engine output. Default: 'warn'
      logLevel: 'warn',
    },

    functions: {
      dir: 'functions',            // relative to server/
      python: { devPath: '.venv/bin/python3' },
    },

    // nvent UI (requires @nvent-addon/app)
    app: {
      enabled: true,
      routePath: '/_nvent',        // default
      layout: false,               // set to a layout name to wrap the UI in a layout
    },
  },
})
```

### Engine adapters

The `queue`, `state`, `cron`, and `stream` modules each accept an `adapter` config. Available types:

| Module | `builtin` (default) | `redis` | `rabbitmq` (queue only) |
|---|---|---|---|
| queue | in-memory or file | `{ type: 'redis', redisUrl }` | `{ type: 'rabbitmq', amqpUrl }` |
| state | in-memory or file | `{ type: 'redis', redisUrl }` | — |
| cron | kv | `{ type: 'redis', redisUrl }` | — |
| stream | in-memory or file | `{ type: 'redis', redisUrl }` | — |

## Monitoring UI

`@nvent-addon/app` adds a monitoring UI at `/_nvent` (configurable via `nvent.app.routePath`).

```ts
export default defineNuxtConfig({
  modules: ['nvent', '@nvent-addon/app'],
})
```

Import the styles in your main CSS file so Tailwind scans the UI components:

```css
@import "tailwindcss";
@import "@nuxt/ui";
@import "@nvent-addon/app";
```

The UI shows active workers, queued jobs, flow topology, real-time logs, OTel traces, and metrics. It also lets you manually invoke any registered function.

You can also embed the UI as a component:

```vue
<template>
  <NventApp />
</template>
```

## Hot reload

In `nuxt dev`, nvent watches `server/functions/` for changes. Adding, editing, or removing function files (TypeScript or Python) triggers a re-scan and re-registration without restarting the server.

## Contributing

```bash
pnpm install
pnpm dev          # builds stubs for all packages
cd playground && pnpm dev  # starts the playground
```

## License

[MIT License](./LICENSE) — Copyright (c) nhealth

## Engine

Nvent uses the [iii engine](https://github.com/iii-hq/iii) for orchestration. The engine binary is downloaded at `nuxt dev` startup and is not bundled with this package.

The iii engine is licensed under the [Elastic License 2.0 (ELv2)](https://github.com/iii-hq/iii/blob/main/engine/LICENSE).
nvent is MIT-licensed. The engine binary is a separate artifact subject to ELv2.
