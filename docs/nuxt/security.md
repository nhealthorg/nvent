# Nuxt Security Guide

This guide explains how to secure browser access to nvent in Nuxt projects.

## What Happens by Default

With nvent browser proxy + RBAC enabled:

1. Browser opens `/_iii/browser`.
2. Nuxt/Nitro mints a short-lived signed token.
3. Proxy forwards the connection to iii RBAC worker-manager.
4. RBAC auth function validates token and grants scoped access.

## Minimal RBAC Setup

`nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  nvent: {
    iii: {
      workerManager: {
        rbac: {
          port: 49135,
          exposeFunctions: [
            'match("pipeline::*")',
          ],
          tokenTtlSeconds: 120,
          allowAnonymous: false,
        },
      },
    },
  },
})
```

## Add a Stable Secret

Set this in your runtime environment:

- `NVENT_BROWSER_AUTH_SECRET`

Without it, development fallback behavior may use an ephemeral startup secret.

## Integrating Existing Auth

Use `authResolverPath` to plug in your own identity/session logic.

Example:

```ts
rbac: {
  // ...
  authResolverPath: './server/security/browser-auth-resolver.ts',
}
```

Resolver responsibilities:

- decide allow/deny
- provide identity context
- narrow callable functions
- control registration capabilities

## Secure Defaults Checklist

- keep `tokenTtlSeconds` low
- set `allowAnonymous: false`
- keep `exposeFunctions` narrow
- avoid exposing internal function namespaces
- return least-privilege `allowedFunctions` in custom resolver

## Troubleshooting

If calls are rejected:

- verify matcher syntax is `match("...")`
- verify app is routing browser traffic through `/_iii/browser`
- verify `NVENT_BROWSER_AUTH_SECRET` is set consistently across instances
- verify custom resolver path is valid and default export exists

## Stream Security

Stream subscriptions (`useIiiStream`) use a different trust model than the RBAC worker port.

### How streams are protected

The iii stream port (`/_iii/stream/**`) is proxied by Nitro but has no built-in authentication by default. The security rests on the `groupId` that clients must supply to subscribe:

- The `groupId` is a UUID (122 bits of entropy), generated server-side when a job starts
- It is returned only to the caller of the Nuxt API route that initiated the job
- A client who does not hold the `groupId` cannot subscribe — guessing it is not feasible

This is the same pattern as S3 pre-signed URLs: the token itself is the secret.

### Where the real trust boundary is

The actual security perimeter is **the Nuxt API route that returns the `groupId`**, not the stream connection itself. If that endpoint is unauthenticated, any client that can call it gets a valid token. Protect it the same way you protect any Nuxt server route:

```ts
// server/api/pipeline.post.ts
export default defineEventHandler(async (event) => {
  // Guard with your session / auth middleware first
  const session = await requireUserSession(event)

  const res = await useIii().trigger({ function_id: 'pipeline::run', payload: { ... } })
  return res // includes streamName + groupId
})
```

### Hardened multi-user streams (`stream_auth_function_id`)

For cases where you need the engine to enforce access per-connection — for example, shared streams that multiple users subscribe to with different read rights — the iii engine supports a `stream_auth_function_id` hook. When configured, the engine calls that function on every WebSocket upgrade for the stream port, passing `{ headers, path, query_params, addr }`. Returning `{ unauthorized: true }` closes the connection.

This lets you validate a session token passed as a query parameter:

```
ws://your-app/_iii/stream/pipeline/some-group-id/?token=SESSION_TOKEN
```

```ts
// server/functions/stream-auth.ts
export default defineIiiFunction(async (input: {
  headers: Record<string, string>
  path: string
  query_params: Record<string, string[]>
  addr: string
}) => {
  const token = input.query_params.token?.[0]
  if (!token || !isValidSessionToken(token)) {
    return { unauthorized: true }
  }
  return { context: { userId: getUserIdFromToken(token) } }
})
```

This is optional — for internal tools and single-user scenarios the UUID `groupId` model is sufficient.

### Stream security checklist

- protect the Nuxt API route that issues the `groupId` with your auth middleware
- use HTTPS in production so the `groupId` in transit is encrypted
- keep `groupId` values out of logs and error responses
- for multi-user apps sharing streams, configure `stream_auth_function_id`
- do not embed `groupId` in publicly accessible URLs

## References

- [Nuxt Overview](./README.md)
- [Browser SDK](./browser-sdk.md)
- [Security Layer Spec](../../specs/v1.0/security-layer.md)
