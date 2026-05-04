# Browser SDK

nvent wires `iii-browser-sdk` into Nuxt so browser tabs can call server
functions, subscribe to streams, and register their own handlers — without
ever needing a direct connection to the iii engine.

## How it works

```
Browser tab
  └─ useIii()  ─── /_iii/browser ──►  Nitro proxy
                                           └─── iii RBAC port (49135)
  └─ useIiiStream() ─── /_iii/stream/** ──► iii stream port (3112)
```

The browser connects to your Nuxt origin only. Nitro forwards the connections
to the correct iii ports — no CORS, no direct port exposure.

## `useIii()` — call server functions

Auto-imported in all Vue components and composables. Returns the connected
`iii-browser-sdk` instance.

```vue
<script setup lang="ts">
const iii = useIii()

// Call a server function and await the result
const result = await iii.trigger({
  function_id: 'greet',
  payload: { name: 'World' },
})

// Fire-and-forget (void)
import { TriggerAction } from 'iii-browser-sdk'
await iii.trigger({
  function_id: 'analytics::track',
  payload: { event: 'page_view' },
  action: TriggerAction.Void(),
})
</script>
```

### Registering a browser-side handler

The server can call back into a browser tab by triggering a function the tab
has registered:

```ts
const iii = useIii()

// Register a handler — the server can now call 'ui::notify'
iii.registerFunction('ui::notify', async (data: { message: string }) => {
  alert(data.message)
})
```

Each browser tab gets its own namespace automatically (enforced by iii RBAC) —
functions registered in one tab cannot be reached from another.

## `useIiiStream()` — subscribe to a stream

Subscribe to a named iii stream group and receive real-time updates reactively.

```vue
<script setup lang="ts">
const { messages, status, subscribe, close } = useIiiStream<{
  label: string
  step: number
  progress: number
}>()

// Start listening to a specific group (e.g. a job ID)
onMounted(() => subscribe('pipeline', props.jobId))
onUnmounted(() => close())
</script>

<template>
  <div v-if="status === 'connected'">
    <p v-for="msg in messages" :key="msg.step">
      {{ msg.label }}: {{ msg.progress }}%
    </p>
  </div>
  <span v-else>{{ status }}</span>
</template>
```

### Stream status values

| Status       | Meaning                                      |
|--------------|----------------------------------------------|
| `idle`       | Not yet subscribed                           |
| `connecting` | WebSocket opening                            |
| `connected`  | Receiving events                             |
| `closed`     | Connection closed cleanly                    |
| `error`      | Connection error (check browser console)     |

### Publishing to a stream (server-side)

From any server handler or function:

```ts
const iii = useIii()
await iii.trigger({
  function_id: 'stream::set',
  payload: {
    stream_name: 'pipeline',
    group_id: jobId,
    item_id: stepId,
    data: { label: 'Classifying', step: 2, progress: 60 },
  },
})
```

### Stream security

Stream subscriptions are protected by the `groupId`, not by the RBAC worker port. The `groupId` is a UUID (122 bits of entropy) — it functions as a capability token. Whoever holds it can subscribe; anyone without it cannot, and guessing it is not feasible.

The real trust boundary is **the server route that hands the `groupId` to the client**. Always guard that route with your session/auth middleware:

```ts
// server/api/pipeline.post.ts
export default defineEventHandler(async (event) => {
  const session = await requireUserSession(event) // guard first
  const res = await useIii().trigger({ function_id: 'pipeline::run', payload: { ... } })
  return res // returns { streamName, groupId } only to authenticated caller
})
```

For multi-user apps where the engine should enforce access on every WebSocket upgrade, configure a `stream_auth_function_id` in the iii engine — it receives the connection headers and query params and can reject the connection. See [Security](./security.md#stream-security) for details.

## Security (RBAC)

By default, browsers connect as anonymous users. For authenticated access,
enable RBAC in `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  nvent: {
    iii: {
      workerManager: {
        rbac: {
          port: 49135,                             // default
          exposeFunctions: ['match("api::*")'],    // what browsers can call
          allowAnonymous: false,                   // require auth
          tokenTtlSeconds: 120,                    // default
        },
      },
    },
  },
})
```

Set a stable secret so tokens survive restarts:

```bash
NVENT_BROWSER_AUTH_SECRET=your-secret-here
```

### Custom auth resolver

Plug in your own session/identity logic by pointing at a resolver module:

```ts
rbac: {
  authResolverPath: './server/security/browser-auth.ts',
}
```

The resolver receives the raw iii `AuthInput` and returns an `AuthResult`:

```ts
// server/security/browser-auth.ts
import type { AuthInput, AuthResult } from 'iii-sdk'

export default async function resolve(input: AuthInput): Promise<AuthResult | null> {
  // input.query_params._nvent_token contains the signed Nuxt session token
  // Return null to fall back to nvent's default anonymous/token handling
  const session = await useSession(/* … */)
  if (!session?.userId) return null

  return {
    function_registration_prefix: `browser::${session.userId}`,
    allow_function_registration: true,
    allow_trigger_type_registration: false,
    context: { userId: session.userId, role: session.role },
  }
}
```

For more details see [Security](./security.md).

## What browsers can and cannot do (defaults)

| Capability                        | Default    | Config key                        |
|-----------------------------------|------------|-----------------------------------|
| Call `api::*` server functions    | ✅          | `exposeFunctions`                 |
| Register own handlers             | ✅          | `allowFunctionRegistration`       |
| Register trigger types            | ❌          | `allowTriggerTypeRegistration`    |
| Reach internal iii engine port    | ❌ never    | not configurable                  |
| Interfere with another tab        | ❌ never    | enforced by prefix isolation      |
| Subscribe to any stream group     | ✅ with groupId | guard the API route that issues it |
| Subscribe without groupId         | ❌ never    | UUID unguessability               |
