# Durable Agent Concurrency Groups

Native workflow agents can share a durable admission limit across workflow runs:

```ts
const selection = await ctx.call('resolve-agent-settings', { projectId })
const result = await ctx.agent({
  prompt: 'Extract the requested fields.',
  input: document,
  task: { title: 'extract' },
}, {
  concurrencyGroup: {
    key: ctx.cond.prop(selection, 'concurrencyKey'),
    limit: ctx.cond.prop(selection, 'concurrencyLimit'),
  },
  response: { format: 'json', onInvalid: 'retry', maxAttempts: 2 },
})
```

The exact option type is
`concurrencyGroup?: { key: string | WorkflowValueRef; limit: number | WorkflowValueRef }`.
Literals work too, for example `{ key: 'project:123:llm', limit: 3 }`.
Keys must resolve to nonempty strings; limits must resolve to positive safe integers.
The wire option is `concurrencyGroup` (the Rust decoder also accepts
`concurrency_group`); both fields support the existing workflow reference converter.
References participate in dependency collection and runtime input resolution.

## Scope and Scheduling

The key is shared by all runs using the same workflow-internal state store.
Include a project identifier in the key for project-local limits. No portal UI or
settings lookup is provided: the caller supplies settings as literals or workflow
references. Queue concurrency is independent and does not bound harness sessions.

Grouped invocations use dedicated native harness sessions, rather than reusing
the run's conversation. Agents remain durable asynchronous nodes, not awaited
function executions. Admission persists an owner identified by run, node, and
attempt before any harness RPC. Full groups leave nodes `Pending`, do not consume
retries, and are revisited by the normal sweep. There are no slot-waiting
in-process semaphores. Admission is not FIFO and does not guarantee fairness.

The effective admission limit is the minimum of the incoming request's limit and
the limits of current holders with the same key. Lowering a limit never evicts
live holders; no new admission occurs until capacity is below that minimum.
Increasing a limit takes full effect after holders with smaller limits finish.
Use consistent limits for the same key when a stable ceiling is required.

## Durability and Failure Handling

Redis uses atomic Lua admission and durable event claims. The file backend holds
an OS file lock across reading, counting, and atomically replacing the permit
ledger, and syncs the ledger and directory before returning. All file workers
must share the same directory on a filesystem supporting advisory file locks and
atomic rename. The file locking API requires Rust 1.89 or later. Never point
workers in one deployment at independent file directories. If Redis is selected
without a valid URL, grouped admission fails closed instead of using the ordinary
host-local file fallback. Explicitly select the file backend for shared-file use.

Structured-response retries keep the permit. A release requires a terminal
harness status for the expected turn, not just a terminal workflow checkpoint,
elapsed timeout, or successful stop RPC. Sweep polls known sessions, retries stop
for abandoned owners, and reconciles safely identifiable terminal owners even
after run deletion. Run deletion does not delete the independent permit ledger.
The sweep must remain enabled for recovery and waiting-node progress.

Permits have no expiry. A transport-ambiguous spawn/send, crash before recording
its session/turn, or interrupted event claim can retain capacity indefinitely.
This is deliberate: the harness has no owner-idempotent spawn or authoritative
lookup by permit owner, so reclaiming these owners automatically could exceed
the live-session limit. Such owners are logged and require operator reconciliation.
After stopping the relevant workers and definitively verifying the underlying
sessions/dispatches cannot still execute, an operator can remove the specific
owner from Redis hash `nvent:wf:agent-permits:v1` or the file ledger
`agent-permits.json`. Never clear the ledger or expire entries to repair a stall
while possibly live dispatches remain.

Redis persistence/replication must retain acknowledged permit writes across
failover. Losing the ledger while harness sessions remain live invalidates the
bound. Existing run-lock ownership constraints still apply: route a given run's
mutations to one owning engine instance. Group admission itself is cross-process,
but this feature does not retrofit distributed locking for every run mutation.

## Deployment

Deploy the updated SDK and workflow-worker binary together, then rebuild/restart
consumers. Installing an older released package does not include these source
changes. The SDK exposes `ctx.agentConcurrencyGroups === true` for consumer
capability checks. This does not verify the connected worker version: older
workers with strict option decoding reject the new option, so mixed-version rollout is not
supported for grouped workflows. Existing ungrouped sessions are not counted or
retroactively admitted. Drain them before relying on a newly enabled ceiling.