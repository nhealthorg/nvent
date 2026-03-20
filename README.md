# Nvent

Nvent is a Nuxt module for building event-driven backend workflows. Functions are declared in `server/functions/`, auto-discovered at startup, and wired to triggers (HTTP, queue, cron, stream, state change). A persistent orchestration engine runs alongside your Nuxt server and handles scheduling, state, queuing, and real-time streams. Nvent provides the TypeScript API and Nuxt integration on top of it.

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

```ts
// server/functions/orders/process.ts
import { defineFunction } from '#imports'

export default defineFunction({
  triggers: [{ type: 'queue', config: { topic: 'order.placed' } }],
  handler: async (input: { orderId: string }, ctx) => {
    ctx.logger.info('Processing order', { orderId: input.orderId })
    await ctx.state.set('status', 'processing')
    await ctx.enqueue({ topic: 'order.processed', data: input })
    return { ok: true }
  },
})
```

### Trigger types

| Type | Description |
|---|---|
| `http` | Exposes an HTTP endpoint via the engine's REST API |
| `queue` | Consumes messages from a named topic |
| `cron` | Runs on a cron schedule |
| `state` | Fires when a state key is set, changed, or deleted |
| `stream` | Fires on stream updates or when clients join/leave |
| `subscribe` | General pub/sub subscription |

```ts
// HTTP trigger — input is typed as HttpRequest automatically
export default defineFunction({
  triggers: [{ type: 'http', config: { api_path: 'greet', http_method: 'POST' } }],
  handler: async (req, ctx) => {
    return { status: 200, body: { hello: req.query_params.name } }
  },
})

// Cron trigger
export default defineFunction({
  triggers: [{ type: 'cron', config: { expression: '0 9 * * *' } }],
  handler: async (_input, ctx) => {
    await runDailyReport()
  },
})
```

### ctx.match()

When a function responds to multiple trigger types, use `ctx.match()` to branch by trigger type with correct input typing per branch:

```ts
export default defineFunction({
  triggers: [
    { type: 'http', config: { api_path: 'ping', http_method: 'GET' } },
    { type: 'cron', config: { expression: '*/5 * * * *' } },
  ],
  handler: async (input, ctx) =>
    ctx.match(input, {
      http: (req) => ({ status: 200, body: { ping: 'pong' } }),
      cron: () => { ping() },
    }),
})
```

### Function context

Every handler receives `ctx` with:

```ts
ctx.logger          // structured logger (info, warn, error, debug, trace)
ctx.state           // key/value state scoped to the function ID
ctx.stream          // real-time stream channel (persistent items + ephemeral events)
ctx.triggerType     // 'http' | 'queue' | 'cron' | 'state' | 'stream' | 'subscribe' | 'log'
ctx.enqueue()       // publish a message to a topic
ctx.enqueueNamed()  // dispatch to a specific function via a named queue
ctx.match()         // branch by trigger type with typed input per branch
```

#### State

State is scoped to the function ID and persists across invocations:

```ts
await ctx.state.get('key')
await ctx.state.set('key', value)
await ctx.state.delete('key')
await ctx.state.update('key', ops)  // JSON patch operations
await ctx.state.list()              // all keys in this scope
```

#### Streams

Streams provide a real-time channel per function invocation. Items written with `ctx.stream.set()` are persisted and delivered to any WebSocket subscriber. `ctx.stream.send()` is fire-and-forget.

The stream channel is identified by `{ streamName, groupId }`. When a function is triggered via HTTP, calling `ctx.stream.subscription()` generates a stable `groupId` for that request. Any downstream step reached via `ctx.enqueue()` inherits the same `groupId` automatically — the client subscribes once and receives updates from the entire chain.

```ts
// HTTP step: open a stream channel and return its coordinates to the client
const { streamName, groupId } = ctx.stream.subscription()
await ctx.enqueue({ topic: 'process.start', data: input })
return { status: 200, body: { streamName, groupId } }

// Queue step: write to the inherited channel (no manual wiring needed)
await ctx.stream.set('step-1', { label: 'Tokenizing', progress: 0.3 })
await ctx.stream.send({ type: 'done' })
```

To read from or write to an explicit stream (cross-function):

```ts
await ctx.stream.setIn(name, groupId, itemId, data)
await ctx.stream.get(name, groupId, itemId)
await ctx.stream.list(name, groupId)
await ctx.stream.sendTo(name, groupId, data)
```

## Flows

Functions that share a `flows` name are grouped into a flow and visualized together in the UI. A flow is defined implicitly: there is no separate flow declaration file.

```ts
// server/functions/checkout/validate.ts
export default defineFunction({
  flows: ['checkout'],
  triggers: [{ type: 'queue', config: { topic: 'checkout.started' } }],
  enqueues: ['checkout.validated'],
  handler: async (input, ctx) => {
    await validate(input)
    await ctx.enqueue({ topic: 'checkout.validated', data: input })
  },
})

// server/functions/checkout/charge.ts
export default defineFunction({
  flows: ['checkout'],
  triggers: [{ type: 'queue', config: { topic: 'checkout.validated' } }],
  handler: async (input, ctx) => {
    await charge(input)
  },
})
```

The `enqueues` field is metadata only — it tells the UI which topics a function produces so the flow graph can be rendered without running any code.

## Python functions

Python functions are supported alongside TypeScript. Place `.py` files in `server/functions/` following the same naming convention. In development, nvent looks for the interpreter at the path configured in `nvent.functions.python.devPath`; in production set the `NVENT_PYTHON_BIN` environment variable.

```ts
// nuxt.config.ts
nvent: {
  functions: {
    python: { devPath: '.venv/bin/python3' },
  },
}
```

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

In `nuxt dev`, nvent watches `server/functions/` for changes. Adding, editing, or removing function files triggers a re-scan and re-registration without restarting the server.

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