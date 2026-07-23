# Nvent

Nvent is a Nuxt module for building event-driven backend workflows. It provides a developer-friendly API to define resilient, multi-step workflows directly in your Nuxt project, powered by the high-performance [iii orchestration engine](https://iii.dev).

## Features

- **Built-in Orchestration**: Integrated state, queues, and cron management via the iii engine.
- **Resilient Workflows**: Define multi-step DAGs with automatic retries and state persistence.
- **Type-Safe**: Full TypeScript support with Zod integration for input/output validation.
- **Python Support**: Run Python functions alongside your TypeScript code with seamless orchestration.
- **Monitoring UI**: Real-time visualization of your backend flows, logs, and OTel traces.

## 🚀 Getting Started

### 1. Installation

```bash
pnpm add nvent
```

### 2. Module Setup

Add the module to your `nuxt.config.ts`. No further configuration is required for local development; the engine binary will be auto-downloaded on first start.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nvent'],
})
```

## 🛠️ Defining Backend Logic

Nvent uses two primary abstractions for backend logic: **Functions** and **Workflows**. Both are stored in `server/functions/` and `server/workflows/` and are auto-discovered.

### Single-Step: `defineFunction`

Use `defineFunction` for simple, standalone logic triggered by events like HTTP requests or queue messages.

```ts
// server/functions/orders/notify.ts
import { defineFunction } from '#nvent/server'

export default defineFunction({
  description: 'Send order confirmation',
  triggers: [{ type: 'durable:subscriber', config: { topic: 'order.placed' } }],
  handler: async (event) => {
    // Send email logic...
    return { ok: true }
  },
})
```

### Multi-Step DAG: `defineWorkflow`

For complex processes, use `defineWorkflow` to define a functional DAG. The engine handles the execution, retries, and state between steps.

```ts
// server/workflows/onboarding.ts
import { defineWorkflow } from '#nvent/server'

export default defineWorkflow({
  name: 'user-onboarding',
  handler: async (ctx, input) => {
    // Run steps in parallel or sequence
    const user = await ctx.call('users::create', input)
    
    await ctx.all(c => [
      c.branch(async b => {
        const mail = await b.call('email::prepare', user)
        return b.call('email::send-welcome', mail)
      }),
      c.branch(async b => {
        await b.call('crm::enrich-lead', user)
        return b.call('crm::add-lead', user)
      }),
    ])
    
    return user
  },
})
```

## 🏗️ The iii Engine

Nvent is built on top of the [iii engine](https://iii.dev), a high-performance orchestration layer. When you run `nuxt dev`, nvent automatically manages the engine lifecycle for you. 

- **State Persistence**: Workflows are resumable and survive server restarts.
- **Distributed Queues**: Built-in support for concurrent and FIFO queues.
- **OTel Observability**: Native OpenTelemetry integration for traces and metrics.

## 📊 Monitoring & UI

For real-time monitoring, add the optional `@nvent-addon/app` module.

```bash
pnpm add @nvent-addon/app
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nvent', '@nvent-addon/app'],
})
```

By default, this exposes a dashboard at `/_nvent` where you can:
- Visualize workflow execution DAGs.
- Inspect real-time logs and OTel traces.
- Manually trigger functions and monitor the state store.

You can also embed the monitoring view directly in your own pages using the `<NventApp />` component.

## 🐍 Python Support

Nvent supports Python functions out of the box. Simply place `.py` files in `server/functions/` and use the Python iii SDK to define handlers.

```python
# server/functions/analyze.py
from nvent import define_function, queue

async def handler(data: dict):
    # Process data...
    return {"status": "success"}

define_function(
    triggers=[queue("data.analyze")],
    handler=handler,
)
```

## License

[MIT License](./LICENSE) — Copyright (c) nhealth
Core Engine: [ELv2](https://github.com/iii-hq/iii/blob/main/engine/LICENSE)
