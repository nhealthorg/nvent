# Stream Channel Integration Spec

Status: Draft

Kurz: Diese Spec beschreibt das Design, API‑Primitives und Integrationsschritte, um `returnType: 'stream'` in Workflows über iii‑Channels für alle Laufzeit‑Sprachen (TS/Python/Rust) verfügbar zu machen.

Ziel
- Entwickler geben in `defineWorkflow`/`ctx.call` nur `{ returnType: 'stream' }` an.
- Engine/Worker erstellt/verwaltet iii‑Channels, stellt Writer an Producer und Reader an Consumer bereit.
- Stream funktioniert sprach‑unabhängig; Consumer liest per AsyncIterator/Stream.

Grundprinzip
- `ctx.call(..., { returnType: 'stream' })` erzeugt an der Node ein `StreamChannelRef`-Handle zurück: `{ type: 'stream', channelRef: { id: string } }`.
- Producer bekommt beim Ausführen ein `ctx.stream`-Objekt (Writer-API) oder kann bei low-level SDK `openChannelWriter(channelId)` nutzen.
- Consumer bekommt `channelRef` im Input (automatisch vom Engine zugewiesen) und öffnet einen Reader `openChannelReader(channelId)`.
- Engine nutzt iii Channels (https://iii.dev/docs/understanding-iii/channels) als Broker; wir kapseln iii intern.

Channel Contract
- ChannelId: global, tenant-scoped, opaque string (e.g. `chan:tenant:uuid`).
- Chunk: { seq: number, type: 'data'|'eof'|'error', contentType?: string, payload: bytes|json, checksum?: string }
- EOF: expliziter `type: 'eof'` Chunk.
- Errors: `type: 'error'` mit code/message.
- TTL: channel expires after configurable TTL (default 60s) after EOF or last activity.

API‑Primitives (Engine / Worker internal)
- createStreamChannel(opts) -> { id }
- openChannelWriter(channelId) -> { write(chunk): Promise, end(): Promise, abort(err): Promise }
- openChannelReader(channelId) -> AsyncIterator<Chunk> (supports cancel)
- to SDKs: wrapper methods `ctx.createStream(...)`, `ctx.stream.write(...)`, `ctx.stream.end()`

Developer API (consumer/producer) — Beispiele

- Producer (TypeScript handler)
```ts
export async function handler(input, ctx) {
  const streamRef = await ctx.call('produceLarge', 'app::produceLarge', input, { returnType: 'stream' })
  // OR, if implementing within a function that itself produces stream:
  const stream = ctx.stream // provided by runtime
  for (const chunk of produceChunks()) {
    await stream.write(chunk)
  }
  await stream.end()
  return streamRef
}
```

- Consumer (TypeScript queued function)
```ts
export async function handler(input, ctx) {
  const channelId = input.dataChannel?.id || input.nodeProducer?.channelRef?.id
  const reader = await ctx.engine.openChannelReader(channelId)
  for await (const chunk of reader) {
    // process chunk
  }
  return { ok: true }
}
```

- Producer (Python sketch)
```py
async def handler(input, ctx):
  stream_ref = await ctx.call('produce', input, returnType='stream')
  stream = ctx.stream
  async for chunk in produce_chunks():
    await stream.write(chunk)
  await stream.end()
  return stream_ref
```

- Consumer (Python)
```py
async def handler(input, ctx):
  channel_id = input['dataChannel']['id']
  async for chunk in ctx.engine.open_channel_reader(channel_id):
    process(chunk)
```

- Rust sketches (pseudo)
Producer:
```rust
let stream = ctx.stream_writer();
while let Some(chunk) = produce.next().await {
  stream.write(chunk).await?; // await for backpressure
}
stream.close().await?;
```
Consumer:
```rust
let mut reader = engine.open_reader(channel_id).await?;
while let Some(chunk) = reader.next().await {
  process(chunk);
}
```

Backpressure & Flow Control
- `write()` is awaitable; broker signals when buffer available.
- Broker maintains per-channel buffer quota; if exceeded, `write()` waits or errors per policy.
- Option `onMemoryFail: 'store'` instructs writer to fallback to persisting remaining data into store and emit storeRef.

Durability & Fallbacks
- Default: ephemeral in-memory channel with TTL.
- Optional durable mode: channel persists to store (disk) to allow late consumers.
- Fallback on writer failure: if configured, worker writes remaining data to `store` and returns `StoreResult` with `key`.

Security
- Channel ownership and access controlled by engine; opening reader/writer requires tenant auth.
- ChannelRef must not be forgeable; use signed tokens if crossing trust boundaries.

Observability
- Emit events: `stream:opened`, `stream:chunk`, `stream:ended`, `stream:error` with runId/nodeId/size.

Implementation steps (MVP)
1. Extend `defineWorkflow.ts`: accept `returnType: 'stream'` in `CallOptions` and write `nodeDef.result`.
2. Engine: implement `createStreamChannel`, wrap iii Channel APIs and expose openWriter/openReader.
3. Worker runtimes: expose `ctx.stream` writer to producers and engine reader helper to consumers for TS/Python/Rust.
4. Playground examples + tests for same-host and cross-host streaming; test TTL and onMemoryFail fallback.
5. Docs and Devtools support (timeline, stream inspector).

Limitations
- Cross-host streaming requires central broker (iii Channels) reachable by all workers.
- Latency/throughput depends on broker implementation and network.

Open questions
- Default TTL (proposal: 60s)
- Chunk max size and default chunk framing
- Whether to allow multiple concurrent readers per channel (recommend: single consumer per channel for ordered processing)


