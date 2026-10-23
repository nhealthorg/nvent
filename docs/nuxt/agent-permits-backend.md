# Agent Permit Management Backend

These operator RPCs belong to the Rust workflow worker. The caller must enforce
operator authorization and route management to the worker owning the run.
Per-run locks are in-process, not distributed locks. Do not use these recovery
operations against a ledger shared by independently active owners of the same run.

## RPC Contract

`nworkflow::agent-permits-list` accepts `{}` and returns:

```json
{
  "permits": [{
    "owner": "owner-id",
    "key": "group-key",
    "limit": 2,
    "run_id": "run-id",
    "node_uid": "node-id",
    "attempt": 0,
    "session_id": "session-id",
    "turn_id": "turn-id",
    "dispatch_uncertain": false,
    "event_claimed": false
  }],
  "groups": [{"key": "group-key", "limit": 2, "active": 1}]
}
```

Session and turn IDs can be null. Groups are derived from currently held permits;
the effective limit is the minimum limit among those permits. Empty groups are
not returned. Listing reads the internal ledger, not harness sessions.

`nworkflow::agent-permits-manage` accepts:

```json
{
  "owner": "owner-id",
  "action": "check",
  "reason": null,
  "confirmation": null,
  "actor": "portal-operator-id"
}
```

Actions are `check`, `stop`, and `force_release`. The response is always shaped
as `{ "owner": "owner-id", "outcome": "retained", "message": "..." }` on
success. Outcomes are `released`, `retained`, and `not_found`. Invalid payloads
and persistence or reconciliation failures return RPC errors instead.

## Safety Rules

- `check` acquires the run lock with `cleanup_timeout_ms`, checks the full permit
  snapshot, and requests authoritative terminal status for the exact session and
  turn. Unknown dispatches, missing turn identity, Pending retries, changed task
  identities, changed node attempts, and unavailable status retain capacity.
- A stuck `event_claimed` can be recovered only under that run lock with terminal
  verification. Event handlers now claim only after acquiring the same lock.
  Active matching tasks enter the existing event handler under that guard; its
  existing validation/retry/completion rules remain authoritative. Check does not
  directly invent a workflow business result or clear a claim for later replay.
- `stop` first calls the existing workflow stop handler without a held run lock.
  This cancels the entire workflow, not only the selected agent. It then sends a
  bounded `harness::stop` for the selected permit session and checks terminal
  status. Stop acknowledgement alone never releases capacity. A stop failure can
  leave the run cancelled but the permit retained; check again later.
- `force_release` requires `confirmation` exactly equal to `owner` and a reason
  containing non-whitespace characters. It acquires the bounded run lock and
  refuses any existing nonterminal run, including an aborted nonterminal run.
  A stale claimed flag on a terminal/missing run is allowed once the owning
  worker's run lock is acquired. It never bypasses a live same-process handler.
- Release compares the complete captured permit, including dispatch, turn, and
  claim fields. File storage uses the OS ledger lock; Redis uses a decoded
  full-field comparison followed by Lua compare-and-delete of the exact raw
  value. Changes before deletion retain the permit.

## Audit And Limitations

Force release persists a `requested` run-log audit entry before CAS deletion,
including an operation ID, owner, action, actor, reason, and outcome. A second
entry records the CAS result. Audit storage accepts missing/deleted runs. A failed
intent write prevents release; a failed outcome write leaves the durable intent
and emits an error trace. File audit writes sync the file and directory. Redis
durability follows the configured Redis persistence policy. Normal log deletion
and retention still apply; this is not an immutable compliance audit ledger.

The portal should supply a server-derived actor; omitted/blank actors default to
`operator`. The worker does not authenticate that field. Never include clinical
values, prompts, outputs, or patient identifiers in actor/reason. Audit records
contain operator metadata, not harness results.

Force release does not prove that a remote harness session is dead. A surviving
session may continue work and exceed the configured concurrency capacity. Use it
only after externally verifying termination or explicitly accepting that risk.
Bounded lock acquisition and individual harness calls do not impose a single
global deadline on workflow stop or business-event reconciliation.

Workers predating the claim-after-lock change must not remain active against the
same run during recovery. Multi-owner or mixed-version deployments require
external ownership coordination. No deployment/restart is performed by these
RPC implementations.