# nvent in Nuxt — Getting Started

nvent is a thin Nuxt module that wires the [iii engine](https://iii.dev) into
your Nuxt project. It starts the engine, connects Node/Python/browser workers,
and proxies the ports — so you write plain iii code without any setup ceremony.

## Install

```bash
pnpm add nvent
```

Register the module in `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  modules: ['nvent'],
  nvent: {
    iii: {
      // httpPort: 3111,   // iii REST API (default)
      // wsPort: 49134,    // worker WebSocket (default)
      // streamPort: 3112, // stream WebSocket (default)
    },
  },
})
```

That's all. On `nuxt dev`, nvent downloads the iii binary (first run only),
starts the engine, and connects the Nitro worker.

## Quick example

Write a function under `server/functions/`:

```ts
// server/functions/greet.ts
import { z } from 'zod'
import { defineFunction, Logger } from '#nvent/server'

const logger = new Logger()
const Input = z.object({ name: z.string() })

export default defineFunction({
  description: 'Greet someone',
  input: Input,
  triggers: [{ type: 'http', config: { api_path: '/greet', http_method: 'POST' } }],
  handler: async (data) => {
    logger.info('Greeting', { name: data.name })
    return { message: `Hello, ${data.name}!` }
  },
})
```

Call it from another server handler:

```ts
// server/api/hello.post.ts
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const iii = useIii()
  return iii.trigger({ function_id: 'greet', payload: body })
})
```

Or from the browser with the `useIii()` composable:

```vue
<script setup>
const iii = useIii()
const result = await iii.trigger({ function_id: 'greet', payload: { name: 'World' } })
</script>
```

## How the file convention works

Each file under `server/functions/` maps to a function ID:

```
server/functions/greet.ts             → greet
server/functions/orders/process.ts    → orders::process
server/functions/ml/classify.ts       → ml::classify
```

nvent scans the directory at startup (and in dev: on every file change), calls
`iii.registerFunction` and `iii.registerTrigger` for each export, and
re-registers on HMR. No manual wiring needed.

## Auto-registered Nitro routes

nvent adds three Nitro routes automatically:

| Route             | Forwards to                        | Purpose                                  |
|-------------------|------------------------------------|------------------------------------------|
| `/functions/**`   | iii engine HTTP port (3111)        | iii built-in `http` trigger type         |
| `/_iii/stream/**` | iii stream WebSocket (3112)        | `useIiiStream` in the browser            |
| `/_iii/browser`   | iii RBAC WebSocket (49135)         | Browser SDK connection (auth-gated)      |

## Next steps

- [Server functions](./server-functions.md) — `defineFunction`, schemas, trigger types
- [Browser SDK](./browser-sdk.md) — `useIii()`, `useIiiStream()`
- [Webhooks & custom triggers](./webhooks-and-triggers.md) — receiving HTTP webhooks, Kafka, etc.
- [Security](./security.md) — RBAC, token TTL, auth resolvers
