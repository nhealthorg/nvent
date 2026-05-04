# Webhooks & Custom Trigger Types

## Webhooks — use a Nitro route

The Nuxt-idiomatic way to receive an external webhook (Stripe, GitHub, any HTTP
POST from a third party) is a Nitro event handler that calls
`useIii().trigger()`. No custom trigger type is needed.

```ts
// server/api/webhooks/stripe.post.ts
import { createError, defineEventHandler, getHeader, readRawBody } from 'h3'
import { TriggerAction } from 'iii-sdk'

export default defineEventHandler(async (event) => {
  // 1. Verify the webhook signature (Stripe example)
  const sig = getHeader(event, 'stripe-signature')
  const raw = await readRawBody(event)
  if (!sig || !raw) throw createError({ statusCode: 400, message: 'Missing signature' })
  verifyStripeSignature(sig, raw, process.env.STRIPE_WEBHOOK_SECRET!)

  // 2. Dispatch to iii — fire-and-forget so the 200 reply is instant
  const body = JSON.parse(raw)
  const iii = useIii()
  await iii.trigger({
    function_id: 'billing::handle-event',
    payload: body,
    action: TriggerAction.Void(),
  })

  return { ok: true }
})
```

This runs entirely within Nitro: no extra port, no engine HTTP server, H3
middleware for auth/rate-limiting, standard Nuxt deployment.

The receiving function in `server/functions/`:

```ts
// server/functions/billing/handle-event.ts
import { z } from 'zod'
import { defineFunction, Logger } from '#nvent/server'

const logger = new Logger()

export default defineFunction({
  description: 'Handle a Stripe webhook event',
  input: z.object({ type: z.string(), data: z.object({ object: z.unknown() }) }),
  handler: async (event) => {
    logger.info('Stripe event', { type: event.type })
    // … billing logic …
  },
})
```

> **Why not use the iii `http` trigger type for webhooks?**
>
> The iii `http` trigger type exposes a route on the engine's own HTTP server
> (port 3111, proxied through `/functions/**`). It is fine for internal tooling
> and direct API calls, but Nitro routes are better for webhooks because you get
> full H3 middleware access (signature verification, rate limiting, body parsing
> control, auth), and the route lives under your Nuxt origin with no extra port.

## Custom trigger types — non-HTTP event sources

`registerTriggerType()` is for event sources that are **not** HTTP requests:
Kafka topics, MQTT, Redis pub/sub, file system watchers, WebSocket servers, etc.

A custom trigger type lets functions declare the trigger in `defineFunction`
just like a built-in type, and has the engine manage registration/unregistration
automatically.

### Step 1 — register the type in `server/plugins/`

```ts
// server/plugins/kafka-trigger.ts
import { Kafka } from 'kafkajs'

const kafka = new Kafka({ brokers: ['localhost:9092'] })

export default defineNitroPlugin(() => {
  const iii = useIii()

  iii.registerTriggerType('kafka', {
    registerTrigger: async ({ functionId, config, triggerFunction }) => {
      const consumer = kafka.consumer({ groupId: config.groupId as string })
      await consumer.connect()
      await consumer.subscribe({ topic: config.topic as string, fromBeginning: false })

      consumer.run({
        eachMessage: async ({ message }) => {
          const payload = JSON.parse(message.value?.toString() ?? '{}')
          await triggerFunction(functionId, payload)
        },
      })

      // Return a cleanup function called when the trigger is unregistered
      return () => consumer.disconnect()
    },
  })
})
```

### Step 2 — use the type in `defineFunction`

```ts
// server/functions/orders/process.ts
import { z } from 'zod'
import { defineFunction, Logger } from '#nvent/server'

const logger = new Logger()

export default defineFunction({
  description: 'Process incoming orders from Kafka',
  input: z.object({ orderId: z.string(), amount: z.number() }),
  triggers: [
    { type: 'kafka', config: { topic: 'orders', groupId: 'order-processor' } },
  ],
  handler: async (order) => {
    logger.info('Processing order', { orderId: order.orderId })
    // … order logic …
  },
})
```

TypeScript accepts custom trigger type names via the `CustomTriggerConfig`
catch-all in `TriggerConfig` — no type augmentation needed.

### Multiple custom trigger types

Register as many custom types as you need, each in its own plugin or in a
single plugin file:

```ts
// server/plugins/triggers.ts
export default defineNitroPlugin(() => {
  const iii = useIii()

  iii.registerTriggerType('mqtt', {
    registerTrigger: async ({ functionId, config, triggerFunction }) => {
      // … MQTT setup …
    },
  })

  iii.registerTriggerType('redis-stream', {
    registerTrigger: async ({ functionId, config, triggerFunction }) => {
      // … Redis XREAD setup …
    },
  })
})
```

### When to use custom trigger types vs a server plugin

| Use case                                      | Approach                                      |
|-----------------------------------------------|-----------------------------------------------|
| Receive an external HTTP webhook              | Nitro route + `useIii().trigger()`            |
| Internal HTTP call between Nuxt routes        | Nitro route + `useIii().trigger()`            |
| Kafka / MQTT / Redis / file watcher           | `registerTriggerType()` in `server/plugins/`  |
| One-off queue subscription not in `defineFunction` | `iii.registerTrigger()` directly in a plugin |
