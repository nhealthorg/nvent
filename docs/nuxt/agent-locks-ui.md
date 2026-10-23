# Agent Locks administration

The nvent app has a separate **Agent Locks** page. With the default component
router, open `/_nvent?view=/agent-locks`, or select **Agent Locks** in the nvent
navigation. A custom `routePath` or component router base changes this URL.
This page manages durable agent concurrency permits, not in-process run mutexes.

## Enable access

Agent permit management is enabled by default. It can be disabled in the
consuming Nuxt application:

```ts
export default defineNuxtConfig({
  runtimeConfig: {
    nventapp: {
      agentPermitAdminEnabled: false,
    },
  },
})
```

The runtime override is `NUXT_NVENTAPP_AGENT_PERMIT_ADMIN_ENABLED=false`.
Permissions are currently intentionally not enforced; the access-control model
will be added separately. POST requests require JSON and matching browser
Origin/Host and Fetch Metadata headers. Reverse proxies must preserve the public
Host header.

The HTTP bridge is `/api/_workflows/agent-permits` (GET and POST), backed by
`nworkflow::agent-permits-list` and `nworkflow::agent-permits-manage`. Actor identity
for force-release audit records is derived from the host user, not the POST body.
Protect direct III RPC access separately with the deployment's access controls.

## Actions

- **Check** verifies the selected session and turn against the harness. It may
  reconcile a confirmed terminal event or safely release a completed permit.
  A busy run, changed owner state, or uncertain dispatch remains held.
- **Stop workflow and agent** cancels the owner workflow and attempts to stop the
  agent, then verifies its terminal state. This is not a blind permit deletion.
  For nested workflows the owner is the displayed child run, not necessarily its
  top-level parent. Parent propagation follows ordinary workflow semantics.
- **Force release** requires a terminal or missing owner run, the exact owner
  string, a nonblank reason, and a UI acknowledgement. A durable audit intent is
  saved before the snapshot-checked deletion. A surviving remote execution can
  exceed the group limit after force release: confirm remote execution has stopped
  before using this emergency action. Missing or unreachable status is not proof
  that an agent stopped.

The page shows group occupancy, owner/run/node IDs, attempt, session and turn IDs,
uncertain dispatches and held event claims. It does not load prompts or extracted
values. Refresh is explicit; no background mutations occur. Retained outcomes are
shown as warnings, and failed requests retain modal input.

## Deployment and recovery

Release the workflow-worker and app addon changes together and rebuild the host
app. Route management to the worker owning the run: existing run mutexes remain
process-local. Redis/file CAS protects owner snapshots but does not replace that
deployment constraint. Keep the normal sweep enabled.

No UI action kills a blocked mutex holder. If Check reports a busy run caused by
an old deadlocked worker, update and restart that worker first, then inspect the
same permit again. A stuck event claim is recoverable only when the owning run
lock is available and terminal harness identity can be confirmed. Otherwise the
slot remains held or requires the explicit emergency procedure above.

Audit entries use the owner run's normal log store and retention. Configure its
persistence and access accordingly, including when the run itself was deleted.