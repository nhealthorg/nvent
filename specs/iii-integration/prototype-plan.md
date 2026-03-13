# nvent – Step Model & iii Engine Integration Plan

## Overview

nvent is a **Nuxt-native layer over the iii engine** — roughly what Motia is to
plain Node.js, but for the full Nuxt/Nitro ecosystem. It manages the engine
lifecycle, generates engine config, auto-discovers Steps from the project
structure, and provides Nuxt-idiomatic DX (auto-imports, composables, Nuxt layers).

### Motia as reference model

[Motia](https://github.com/iii-hq/iii/tree/main/frameworks/motia) is the
official framework on top of iii and defines the core concepts nvent adopts:
- **Step** — the single primitive (config + handler)
- **`flows`** — group Steps for flow visualization
- **`enqueues`** — declare which topics a Step can emit to (tooling / type safety)
- **Standalone imports** — `logger`, `enqueue`, `stateManager` as direct imports,
  no `getContext()` boilerplate in userland
- **Multi-trigger** — one Step responds to multiple trigger types

### nvent vs. Motia — concept mapping

| Concept | Motia | nvent |
|---------|-------|-------|
| Core primitive | `Step` (`config` + `handler` exports) | `defineStep()` (merged composable) |
| File convention | `src/**/*.step.ts` / `*_step.py` | `server/steps/**/*.ts` / `*_step.py` |
| ID derivation | `config.name` (manual) | from file path, override with `id` |
| Trigger config | `config.triggers[]` | same (inside `defineStep`) |
| Flow grouping | `config.flows[]` | same |
| Downstream topics | `config.enqueues[]` | same |
| Logger | `import { logger } from 'motia'` | `logger` auto-imported from `#imports` |
| Queue publish | `import { enqueue } from 'motia'` | `enqueue()` auto-imported |
| State | `import { stateManager } from 'motia'` | `stateManager` auto-imported |
| SDK instance | not exposed directly | `useIii()` in Nitro routes |
| Multi-language | via iii `ExecModule` managing runtimes | via nvent `PythonWorkerManager` |
| Engine management | `iii -c config.yaml` (manual or via ExecModule) | nvent starts/stops engine in Nuxt lifecycle |
| Dev console | iii built-in console | nvent Nuxt layer (`/_nvent`) |

**Key divergence:** Motia runs as a separate process managed by iii's `ExecModule`.
nvent runs *inside* Nitro — the Node.js SDK process IS the Nuxt server. This is
the architectural advantage: no extra processes, full access to Nuxt context,
composables, and database connections within step handlers.

---

**Key Engine Facts**
- Engine WebSocket (workers connect): `ws://localhost:49134`
- Engine HTTP API (registered endpoints): `http://localhost:3111`
- Engine config: `iii-config.yaml`
- SDK package: `iii-sdk` (Apache 2.0)
- Engine binary: `iii` (Elastic License 2.0)
- SDK `registerWorker()` is synchronous — connection is async in background
- Workers auto-reconnect on disconnect with exponential backoff
- Function ID convention: `namespace::name` (e.g. `orders::process`)

---

## Step 1 — Engine Binary Management

**Goal:** The nvent Nuxt module installs and manages the iii engine binary
locally so users never have to do it manually.

### 1.1 Binary Location & Detection
- Store the binary in `node_modules/.nvent/bin/iii` (or `~/.nvent/bin/iii` for global installs)
- On module setup, check if the binary exists and if the version matches the
  configured/expected version (`nvent.iii.version` in config, defaulting to
  latest stable)
- Version check: run `<binary> --version` and compare output

### 1.2 Binary Download
- Detect OS and architecture at module setup time using `process.platform` and
  `process.arch` (node) or `os.platform()` / `os.arch()`
- Map to the correct iii GitHub release asset:
  - `linux/x64` → `iii-linux-x86_64.tar.gz`
  - `linux/arm64` → `iii-linux-aarch64.tar.gz`
  - `darwin/x64` → `iii-macos-x86_64.tar.gz`
  - `darwin/arm64` → `iii-macos-aarch64.tar.gz`
  - `win32/x64` → `iii-windows-x86_64.zip`
- Download from: `https://github.com/iii-hq/iii/releases/download/v<version>/<asset>`
- Verify integrity (checksum if iii provides one in releases)
- Make binary executable (`chmod +x`)
- Implement this as a standalone utility: `packages/nvent/src/iii/install.ts`

### 1.3 Docker Fallback
- If binary download fails or user opts in via config (`nvent.iii.mode: 'docker'`),
  fall back to running the engine via Docker:
  ```
  docker run -p 49134:49134 -p 3111:3111 iiidev/iii --config /config.yaml
  ```
- Detect if Docker is available (`docker info`) before attempting
- Mount the generated `iii-config.yaml` into the container

### 1.4 Config Generation
- On module setup, generate `iii-config.yaml` in the Nuxt build dir (`.nuxt/iii-config.yaml`)
- Map nvent module options to iii engine config structure:
  ```yaml
  port: 49134           # WebSocket port for workers
  modules:
    - class: modules::rest_api::RestApiModule
      config:
        port: 3111
    - class: modules::state::StateModule
      config:
        adapter:
          class: modules::state::adapters::KvStore
          config:
            store_method: file_based
            file_path: ./.data/state
    - class: modules::queue::QueueModule
      config:
        adapter:
          class: modules::queue::BuiltinQueueAdapter
    - class: modules::observability::ObservabilityModule
      config:
        exporter: memory
  ```
- nvent config options map to:
  - `nvent.iii.wsPort` → `port`
  - `nvent.iii.httpPort` → `rest_api.port`
  - `nvent.iii.stateDir` → `state.file_path`
  - Additional modules (cron, queue, observability) toggled by nvent config

### 1.5 Engine Process Lifecycle
- Implement `EngineManager` class in `packages/nvent/src/iii/engine.ts`:
  - `start(configPath)` — spawns engine process, waits for it to be ready
    (poll `http://localhost:3111/health` or detect WebSocket port open)
  - `stop()` — sends SIGTERM, waits for graceful exit
  - `restart(configPath)` — stop + start
  - `isRunning()` — check if process is alive
- Pipe engine stdout/stderr to nvent logger
- In Nuxt dev mode: start engine in `nuxt:ready` hook, stop in process exit handler
- In production (Nitro): engine is expected to be running externally, or nvent starts
  it in `nitro:init` if `nvent.iii.managed: true`

---

## Step 2 — SDK Integration & Worker Initialization

**Goal:** Connect to the running iii engine from Nitro using `iii-sdk` and
register all discovered Steps.

### 2.1 Add iii-sdk Dependency
- `iii-sdk` is already added to `packages/nvent/package.json`
- Auto-import nvent's standalone helpers via Nuxt `addServerImports`:
  - `defineStep()` — core primitive
  - `logger` — proxied logger (works inside step handlers without boilerplate)
  - `enqueue()` — proxied enqueue shorthand
  - `stateManager` — proxied state shorthand
  - `useIii()` — raw iii instance for Nitro route handlers

### 2.2 Nitro Plugin: Worker Connection
- `packages/nvent/src/runtime/nitro/plugins/00.iii-worker.ts`
- On Nitro startup:
  1. Call `registerWorker(BRIDGE_URL, { workerName, reconnectionConfig })` from iii-sdk
  2. Register all Steps from the auto-generated registry
  3. Register all triggers from the registry
  4. Store instance on `nitroApp.$iii` for `useIii()`
- `BRIDGE_URL` defaults to `ws://localhost:49134`, configurable via `nvent.iii.wsUrl`

### 2.3 Step Auto-Discovery
- At build time, scan `server/steps/**/*.ts` (and `.py` for Python) using the
  existing registry scanner
- Extract: `id`, `description`, `triggers`, `enqueues`, `flows` from file exports
- Generate `.nuxt/nvent-registry.mjs` bundled via `build.transpile` so Rollup
  resolves all imports (including `#imports`) correctly
- At runtime: Nitro plugin reads registry, calls `registerFunction` + `registerTrigger`

---

## Step 3 — Step Model & File Conventions

**Goal:** A single, minimal file primitive that handles APIs, background jobs,
workflows, and scheduled tasks — aligned with how Motia defines Steps.

### 3.1 The `defineStep()` Primitive

Every Step file exports a `config` (static metadata) and a `handler` (business
logic). nvent provides `defineStep()` which combines both in Nuxt composable style:

```ts
// server/steps/greet.ts
export default defineStep({
  id: 'greet',                        // iii function ID (auto-derived if omitted)
  description: 'Returns a greeting',
  triggers: [
    { type: 'http', config: { api_path: 'greet', http_method: 'POST' } },
  ],
  enqueues: ['user.greeted'],         // topics this step can emit to (for tooling)
  flows: ['api'],                     // flow groups (for console visualization)
  handler: async (input: { name?: string }) => {
    logger.info('greet called', { input })
    await enqueue({ topic: 'user.greeted', data: { name: input.name } })
    return { message: `Hello, ${input?.name ?? 'world'}!` }
  },
})
```

**Why a merged config+handler API (vs. Motia's separate exports):**
- More Nuxt-idiomatic — matches `defineEventHandler`, `defineNuxtRouteMiddleware`
- Single default export = clear file ownership
- TypeScript inference works naturally through generic constraints

**Transition period:** `defineFunction()` / `defineTrigger()` remain as aliases
during migration.

### 3.2 Step ID Derivation
- `server/steps/orders/process.ts` → ID `orders::process`
- `server/steps/greet.ts` → ID `greet`
- Override via explicit `id` field in the config

### 3.3 Standalone Imports (Motia-style, no `getContext()`)

These are auto-imported from `#imports` in any Step handler, Nitro route, or
server utility.

**`logger`** — Structured logging, proxied over `getContext().logger`:
```ts
import { logger } from '#imports'   // auto-imported, explicit only if needed

export default defineStep({
  // ...
  handler: async (input) => {
    logger.info('Processing order', { orderId: input.orderId })
  },
})
```
Implementation: a lazy proxy — each log call does `getContext().logger.info(…)`
internally so it works inside the ALS context of an active step execution.

**`enqueue`** — Typed queue publish shorthand:
```ts
await enqueue({ topic: 'order.placed', data: { orderId, total } })
// equivalent to: (await useIii()).trigger('enqueue', { topic, data })
```

**`stateManager`** — State read/write shorthand:
```ts
const order = await stateManager.get('orders', orderId)
await stateManager.set('orders', orderId, { status: 'processed' })
// stateManager.update('orders', orderId, ops) for atomic updates
```

All three helpers require an active step execution context (they internally call
methods on the iii instance / getContext). Outside a step handler, use `useIii()`
directly.

### 3.4 Supported Trigger Types
| Type | Config fields | When it runs |
|------|--------------|-------------|
| `http` | `api_path`, `http_method` | HTTP request |
| `cron` | `expression` (7-field cron) | Schedule fires |
| `queue` | `topic` | Message enqueued to topic |
| `state` | `scope`, `key` | State value changes |
| `stream` | `stream_name`, `group_id` | Stream item changes |

### 3.5 Multi-Trigger Steps
One Step can respond to multiple trigger types:
```ts
export default defineStep({
  id: 'orders::process',
  triggers: [
    { type: 'http', config: { api_path: 'orders/process', http_method: 'POST' } },
    { type: 'queue', config: { topic: 'order.placed' } },
    { type: 'cron', config: { expression: '0 0 2 * * * *' } },
  ],
  enqueues: ['order.processed'],
  flows: ['orders'],
  handler: async (input, ctx) => {
    // ctx.trigger tells you which one fired
    if (ctx.is.http) { /* handle HTTP */ }
    if (ctx.is.queue) { /* handle queue */ }
  },
})
```

### 3.6 Flows — Grouping for Visualization
```ts
export default defineStep({
  flows: ['orders', 'notifications'],  // step appears in both flow diagrams
  // ...
})
```
The nvent console reads flow metadata and renders a graph of connected steps
(grouped by `flows` / linked via `enqueues`).

### 3.7 Python Steps
Python steps work exactly as in the current implementation (per-file Python worker
managers, `_step.py` suffix):
```python
# server/steps/analyze_step.py
config = {
  'id': 'analyze',
  'description': 'Text analysis',
  'triggers': [{ 'type': 'http', 'config': { 'api_path': 'analyze', 'http_method': 'POST' } }],
  'flows': ['ml'],
}

async def handler(input):
  return { 'result': analyze(input['text']) }
```

---

## Step 4 — Communication Layer

**Goal:** Utilities for triggering steps and inspecting the engine.

### 4.1 `useIii()` Server Composable
- Returns `{ iii }` — the raw SDK instance
- Available in all Nitro event handlers and server routes (outside step handlers)
- Use for direct `iii.trigger()` calls or engine introspection

```ts
// server/api/orders.post.ts
export default defineEventHandler(async (event) => {
  const { iii } = useIii()
  return iii.trigger('orders::process', await readBody(event))
})
```

### 4.2 `logger` outside step handlers
- Inside step handlers: `logger` auto-import works (ALS context active)
- Outside (Nitro routes etc.): use `console` or a separate structured logger —
  `getContext().logger` will be null outside step execution

### 4.3 Engine Introspection Routes
`/api/_nvent/` routes proxy engine built-ins via `useIii()`:
- `GET /api/_nvent/functions` → `engine::functions::list`
- `GET /api/_nvent/workers` → `engine::workers::list`
- `GET /api/_nvent/triggers` → `engine::triggers::list`
- `GET /api/_nvent/health` → `engine::health::check`
- `GET /api/_nvent/traces` → `engine::traces::list`
- `GET /api/_nvent/logs` → `engine::logs::list`
- `GET /api/_nvent/metrics` → `engine::metrics::list`
- `POST /api/_nvent/trigger/:id` → `iii.trigger(id, body)`

---

## Step 5 — Hot Reload & Dev Experience

**Goal:** Changes to Step files automatically re-register with the engine.

### 5.1 File Watching
- Watch `server/steps/**/*.{ts,py}` for add/change/remove events
- On change:
  1. Re-scan and regenerate `.nuxt/nvent-registry.mjs`
  2. Trigger Nitro HMR so the plugin re-executes
  3. SDK auto-reconnects and re-registers all Steps on reconnect

### 5.2 Per-File Python Workers (current approach, keep it)
- Each `.py` step gets its own `PythonWorkerManager` instance
- Smart HMR: only restart the changed step's Python process

### 5.3 `ExecModule` vs. nvent Worker Connection
Motia uses iii's `ExecModule` to launch and manage the Node.js SDK process.
nvent connects differently — directly from Nitro via the Nitro plugin.
This means:
- No separate `motia dev` subprocess needed
- The Node.js runtime IS the Nitro server
- iii's `ExecModule` is not needed for Node.js steps

For Python steps, nvent's existing `PythonWorkerManager` handles process lifecycle
(equivalent to a custom ExecModule per Python file).

---

## Step 6 — nvent Console Integration

**Goal:** A Nuxt layer providing a iii console with flow visualization,
real-time observability, and management tools.

### 6.1 Console Backend (already implemented)
`/api/_nvent/*` routes — all implemented, proxy engine introspection.

### 6.2 Flow Graph Rendering
The `enqueues` + `triggers` metadata from each Step allows building a directed
graph:
- Node = Step
- Edge = `enqueues` topic → `triggers[type: 'queue'].topic` match
- Groups = `flows` field

The console can visualize this statically (from registry) and overlay live
trace data.

### 6.3 Console Frontend (Nuxt Layer)
- Dashboard: health, worker count, step count
- Steps view: all registered steps, description, trigger types, flows
- Flows view: DAG per flow group (Step → enqueue → Step)
- Triggers view: all active triggers, fire manually
- Traces view: real-time trace tree from `engine::traces::tree`
- Logs view: structured logs from `engine::logs::list`
- State explorer: `state::list_groups` + `state::list`

---

## Step 7 — Configuration Schema

```ts
export default defineNuxtConfig({
  nvent: {
    iii: {
      version: 'latest',            // iii engine version to install/manage
      mode: 'local',                // 'local' | 'docker' | 'remote'
      wsUrl: 'ws://localhost:49134',
      httpPort: 3111,
      managed: true,                // nvent manages engine lifecycle (dev only by default)
      configPath: '.nuxt/iii-config.yaml',
      stateDir: '.data/state',
      modules: {
        state: true,
        queue: true,
        cron: true,
        observability: true,
        stream: true,
        pubsub: true,
      },
    },
    steps: {
      dir: 'server/steps',          // Step discovery directory
    },
    console: {
      enabled: true,
      route: '/_nvent',
    },
  },
})
```

---

## Step 8 — Prototype Example & Smoke Test

### 8.1 Updated File Convention

```
server/steps/
  greet.ts                 # HTTP trigger: POST /greet
  scheduled.ts             # Cron trigger: every minute
  orders/
    process.ts             # Queue trigger: topic 'order.placed'
    notify.ts              # Queue trigger: topic 'order.processed'
  analyze_step.py          # Python: HTTP trigger: POST /analyze
```

### 8.2 Example Steps

```ts
// server/steps/greet.ts
export default defineStep({
  id: 'greet',
  description: 'Returns a greeting',
  triggers: [{ type: 'http', config: { api_path: 'greet', http_method: 'POST' } }],
  enqueues: ['user.greeted'],
  flows: ['api'],
  handler: async (input: { name?: string }) => {
    logger.info('greet called', { input })
    await enqueue({ topic: 'user.greeted', data: { name: input.name } })
    return { message: `Hello, ${input?.name ?? 'world'}!` }
  },
})
```

```ts
// server/steps/orders/process.ts
export default defineStep({
  id: 'orders::process',
  description: 'Process a placed order',
  triggers: [{ type: 'queue', config: { topic: 'order.placed' } }],
  enqueues: ['order.processed'],
  flows: ['orders'],
  handler: async (input: { orderId: string; total: number }) => {
    logger.info('Processing order', { orderId: input.orderId })
    await enqueue({ topic: 'order.processed', data: input })
    return { processed: true }
  },
})
```

### 8.3 Example API Route Using Helper
```ts
// server/api/greet.post.ts
export default defineEventHandler(async (event) => {
  const { iii } = useIii()
  return iii.trigger('greet', await readBody(event))
})
```

### 8.4 Smoke Test Checklist
- [ ] Engine starts when `nuxt dev` runs
- [ ] Engine config is generated in `.nuxt/iii-config.yaml`
- [ ] Steps are discovered from `server/steps/` and registered on startup
- [ ] HTTP trigger reachable at `http://localhost:3111/greet`
- [ ] `logger.info()` appears in engine traces/logs
- [ ] `enqueue()` emits to topic, downstream step receives it
- [ ] Cron trigger fires on schedule
- [ ] `/_nvent` console shows steps, flows, workers, triggers
- [ ] Editing a step file triggers hot reload and re-registration
- [ ] Engine stops when Nuxt dev server stops

---

## Implementation Roadmap

### Phase 1 — Core primitive (now)
- [ ] Implement `defineStep()` merging config + handler
- [ ] Export `logger`, `enqueue`, `stateManager` as lazy proxies via auto-imports
- [ ] Update registry scanner to read `defineStep()` exports (id, triggers, enqueues, flows)
- [ ] Update generated registry template to pass `handler` + new metadata fields

### Phase 2 — Developer Experience
- [ ] Rename step directory: `server/functions/iii/` → `server/steps/`
- [ ] Deprecate `defineFunction()` + `export const meta` + `export const triggers` pattern
- [ ] `defineStep()` as the single recommended API

### Phase 3 — Console Flows View
- [ ] Build flow graph from `enqueues` + `triggers` metadata
- [ ] Render DAG in nvent console frontend

### Phase 4 — Multi-language parity
- [ ] Python step convention: `*_step.py` with `config` dict + `async def handler()`
- [ ] Python `enqueue` / `stateManager` helpers
