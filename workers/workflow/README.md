# nworkflow Worker

## Optional Agent Failure Data

`ctx.agent(spec, { onError: 'return-error' })` opts one native agent node into
failure-as-data. Omit `onError`, or use `'fail'`, to retain fail-fast behavior.
The compiler records this as `nodes[id].agentOptions.onError`; it is interpreted
by the Rust worker, not by JavaScript exception handling during compilation.

```ts
import type { AgentFailureResult } from '#nvent/server'

const result = await ctx.agent<Extraction | AgentFailureResult>({
	prompt: 'Extract the requested fields.',
	input: report,
}, {
	model: 'extractor',
	provider: 'local',
	concurrencyGroup: { key: 'local', limit: 2 },
	onError: 'return-error',
})
return ctx.call('materialize-extraction', { result })
```

`Extraction` above is the application's success-output type. Success payloads
are unchanged, not wrapped. Failed dispatches and terminal agent failures
(including provider context-window rejection and exhausted JSON validation)
produce exactly `{ status: 'failed', error: string }`. The agent node becomes
`Done`, its normal successors receive that object, and the workflow may complete
successfully. Use a success schema without `status: 'failed'` to discriminate the
union. No provider code, HTTP status, session ID or retryability is inferred from
the harness error string. The error is not passed through the success JSON schema.

Native task status and error events still report failure. Both event delivery and
task/status polling apply the same policy, including scoped reduce/fanout nodes.
The declared node result-storage policy applies to recovered data as well.
Provider/model routing, group admission and permit reconciliation are unchanged.
Capacity denial still waits for admission; cancellation, run abort, watchdog
timeouts, state-store failures and invalid workflow definitions are not converted
by this policy. An uncertain dispatch retains its existing permit: error data
does not prove the harness stopped, and does not free capacity.

`hooks.onError` is an existing terminal workflow lifecycle notification, not a
recovery handler. A recovered agent failure does not itself fail the workflow or
invoke that hook. This option adds no workflow-level retry; existing response
validation retries run before an exhausted validation failure is returned.

### Build And Deployment

Both the SDK and the native worker must be updated. Older workers reject the new
option because agent options are strictly deserialized. Deploy the worker before
enabling `onError` in newly compiled workflows; old definitions remain compatible.

From the repository root:

```sh
pnpm --filter nvent build
pnpm run build:worker:package
```

The second command builds the release worker for the host target and copies it
into the matching platform package under `packages/workflow-worker`. Distribute
that updated platform package alongside the SDK, or deploy a separately built
`cargo build --release --manifest-path workers/workflow/Cargo.toml` binary through
the deployment's configured worker path. Reinstall/rebuild the consuming app and
restart its native workflow worker; rebuilding only the JavaScript app is not
sufficient. This change does not update any consuming application or running
worker automatically.

## Credits
Based on iii workflow worker

