# Evaluation: Forked Rust Workflow Worker mit napi-rs

**Status:** 🔬 Evaluation  
**Datum:** 2026-07-10  
**Ziel:** Bewertung eines Forks des offiziellen iii workflow workers mit Custom Extensions via Rust + napi-rs

---

## 1. Executive Summary

### Die Idee
Fork des offiziellen `iii-hq/workers/workflow` (Rust), deployed als **iii Worker**:
- ✅ Dynamic control flow (if/else, while, try/catch)
- ✅ Direct function calls (kein Agent-Wrapper overhead)
- ✅ **Deployed als separater iii Worker** (kein napi-rs!) ⭐
- ✅ Battle-tested DAG Core bleibt erhalten
- ✅ Eigene Features on top
- ✅ **Konsistent mit iii Architektur** (alles über engine) ⭐

### Warum das die beste Lösung ist ⭐
```
┌─────────────────────────────────────────────────────────┐
│ Official Worker (Rust)                                  │
│ ✅ DAG Orchestration                                    │
│ ✅ Run Sharding                                         │
│ ✅ Idempotency                                          │
│ ✅ Battle-tested                                        │
└────────────────────┬────────────────────────────────────┘
                     │ FORK
                     ▼
┌─────────────────────────────────────────────────────────┐
│ nvent-workflow-worker (Forked Rust + Custom)            │
│ ✅ Alles vom Original                                   │
│ ➕ Dynamic execution modes                              │
│ ➕ Function-first (nicht Agent-first)                   │
│ ➕ Conditional nodes, Loops, Error handlers             │
└────────────────────┬────────────────────────────────────┘
                     │ iii SDK (Worker registration)
                     │ workflow::start, workflow::tick
                     ▼
┌─────────────────────────────────────────────────────────┐
│ iii Engine (WebSocket Coordinator)                      │
│                                                          │
│ ┌──────────────┐  ┌─────────────────────────┐          │
│ │ Nuxt Worker  │  │ Workflow Worker (Rust)  │          │
│ │              │  │ Functions: workflow::*   │          │
│ └──────────────┘  └─────────────────────────┘          │
└─────────────────────────────────────────────────────────┘
                     ▲
                     │ iii.trigger('workflow::start')
                     │
┌─────────────────────────────────────────────────────────┐
│ Node.js / Nuxt                                          │
│ await iii.trigger({ function_id: 'workflow::start' })  │
│ ✅ Konsistent mit allen anderen iii Functions!         │
└─────────────────────────────────────────────────────────┘
```

### Key Benefits

**Simplicity:**
- ❌ Kein napi-rs (keine platform-specific builds)
- ❌ Kein mixed Rust/Node.js debugging
- ✅ Standard iii Worker (wie alle anderen auch)

**Consistency:**
- ✅ Alles läuft über iii engine (Functions, State, Queue, Workflows)
- ✅ `iii.trigger('workflow::start')` - same API wie andere Functions

**Development Experience:**
- ✅ `cargo watch --exec run` - hot reload!
- ✅ Separate logs (Rust in eigener shell)
- ✅ Kein Docker in Development nötig

**Production:**
- ✅ Run Sharding funktioniert automatisch (iii engine macht consistent hashing)
- ✅ Horizontal scaling out-of-the-box
- ✅ Standard Docker deployment

**Performance:**
- Latency: 2ms statt 0.3ms (+1.7ms)
- Bei 5min Workflow: 5:00.010 statt 5:00.003 (+7ms = 0.002% overhead)
- **Conclusion: IRRELEVANT** ✅

---

## 2. Technische Machbarkeit

### 2.1 napi-rs Integration ✅

**napi-rs** ermöglicht Rust ↔ Node.js ohne Performance-Verlust:

```rust
// packages/worker/src/lib.rs
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::sync::Mutex;
use std::sync::Arc;

#[napi]
pub struct WorkflowWorker {
    // ✅ Arc + Mutex für thread-safe sharing
    engine: Arc<Mutex<WorkflowEngine>>,
}

#[napi]
impl WorkflowWorker {
    #[napi(constructor)]
    pub fn new(config: WorkflowConfig) -> Result<Self> {
        // ✅ Engine mit eigenem tokio runtime
        let engine = WorkflowEngine::new(config)?;
        Ok(Self { 
            engine: Arc::new(Mutex::new(engine))
        })
    }

    /// Start a workflow (non-blocking)
    /// 
    /// This function returns immediately with a run_id.
    /// The workflow execution happens asynchronously in the Rust tokio runtime.
    /// The Node.js event loop remains free to handle other requests.
    #[napi]
    pub async fn start_workflow(
        &self,
        definition: String,  // JSON
        input: String,       // JSON
    ) -> Result<String> {   // run_id
        // ✅ ASYNC: Nutzt libuv thread pool + tokio runtime
        // Node.js Event Loop wird NICHT blockiert!
        let engine = self.engine.lock().await;
        
        let def: WorkflowDef = serde_json::from_str(&definition)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let inp: Value = serde_json::from_str(&input)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        
        let run_id = engine.start(def, inp).await
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        
        Ok(run_id)
    }

    /// Tick a workflow run (non-blocking)
    #[napi]
    pub async fn tick(&self, run_id: String) -> Result<TickResult> {
        // ✅ ASYNC: Non-blocking
        let engine = self.engine.lock().await;
        engine.tick(run_id).await
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Get workflow status (non-blocking)
    #[napi]
    pub async fn status(&self, run_id: String) -> Result<RunStatus> {
        // ✅ ASYNC: Non-blocking
        let engine = self.engine.lock().await;
        engine.status(run_id).await
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }
}
```

**TypeScript Usage:**
```typescript
// Nuxt Server
import { WorkflowWorker } from '@nvent/worker'

const worker = new WorkflowWorker({
  mode: 'function',  // 'dag' oder 'function'
  iiiUrl: 'ws://localhost:49134',
  shardId: 0,
  shardTotal: 1,
})

const runId = await worker.startWorkflow(definition, input)
const result = await worker.status(runId)
```

**Vorteile:**
- ✅ Kein separater Docker Container nötig (Development)
- ✅ Native Performance (kein Overhead)
- ✅ Type-safe Bindings
- ✅ Shared Memory zwischen Rust und Node.js

**Nachteile:**
- ⚠️ Compile-Zeit erhöht (Rust muss gebaut werden)
- ⚠️ Platform-spezifische Binaries (.node files für Linux/Mac/Windows)
- ⚠️ Debugging komplexer (Rust + Node.js)

---

### 2.2 Fork Maintenance Strategy

#### Upstream Sync Strategy
```bash
# Setup
git remote add upstream https://github.com/iii-hq/workers.git
git subtree add --prefix=packages/worker/rust upstream main --squash

# Periodic Updates (z.B. monatlich)
git subtree pull --prefix=packages/worker/rust upstream main --squash
```

**Oder: Git Submodule + Patch Files:**
```
packages/worker/
  ├── rust/                    # Submodule → iii-hq/workers/workflow
  ├── patches/
  │   ├── 001-add-function-mode.patch
  │   ├── 002-add-dynamic-branching.patch
  │   └── 003-napi-bindings.patch
  └── build.rs                 # Apply patches + build
```

**Maintenance Effort:**
- 📅 **Initial:** 2-3 Wochen (Fork setup, napi-rs, erste Extensions)
- 📅 **Monthly:** 1-2 Tage (Upstream sync, conflict resolution)
- 📅 **Per Feature:** 3-5 Tage (z.B. dynamic branching implementieren)

**Risiko-Mitigation:**
- ✅ Automated tests aus original worker übernehmen
- ✅ CI Pipeline für jeden Upstream merge
- ✅ Feature Flags für neue Funktionen

---

## 2.3 Thread Model & Performance ⚡

### Non-Blocking Architecture ✅

**Kritisch:** Alle napi-rs Funktionen MÜSSEN async sein, um Node.js Event Loop nicht zu blockieren!

```typescript
// Nuxt/Nitro Server Handler
export default defineEventHandler(async (event) => {
  // ✅ Non-blocking: Node.js kann andere Requests parallel bearbeiten
  const runId = await worker.startWorkflow(definition, input)
  
  // Event Loop ist frei während Rust arbeitet
  return { runId }
})
```

**Warum das funktioniert:**

1. **`await worker.startWorkflow()`** gibt sofort eine Promise zurück
2. **Node.js Event Loop** bleibt frei für andere Requests
3. **Rust tokio runtime** (separater Thread) macht die Arbeit:
   - WebSocket I/O zu iii engine
   - State operations
   - DAG orchestration
4. **Promise resolves** wenn Rust fertig ist
5. **Node.js Event Loop** nimmt das Result entgegen

```
Request 1:  ──────┐ (await worker.start)
                  ▼
              [Promise] ────────────────────────┐
                                                ▼
Request 2:  ────────────────┐ (await)       [Rust tokio]
                            ▼               (eigener Thread)
                        [Promise] ───────────┐
                                             ▼
                                        [Processing...]
Node.js Event Loop: ■■■■■■■■■■■■■■■■■■■■  (frei!)
                         ▲           ▲
                         │           │
                    Response 1   Response 2
```

### Performance Characteristics

| Operation | Latency | Blocks Node.js? |
|-----------|---------|-----------------|
| `worker.startWorkflow()` | <1ms | ❌ No (async) |
| `worker.tick()` | <1ms | ❌ No (async) |
| `worker.status()` | <1ms | ❌ No (async) |
| Workflow DAG execution | Variable | ❌ No (separate thread) |
| iii WebSocket I/O | Variable | ❌ No (tokio runtime) |

### Memory & Thread Usage

```
┌─────────────────────────────────────────────────────┐
│ Node.js Process                                     │
│                                                      │
│ ┌──────────────────────────────────────────┐        │
│ │ Main Thread (Event Loop)                 │        │
│ │ - Handle HTTP requests                   │        │
│ │ - Execute JS code                        │        │
│ │ - Call napi-rs (non-blocking)            │        │
│ └──────────────────────────────────────────┘        │
│                                                      │
│ ┌──────────────────────────────────────────┐        │
│ │ libuv Thread Pool (4-128 threads)        │        │
│ │ - File I/O                               │        │
│ │ - DNS lookups                            │        │
│ │ - napi-rs async calls                    │        │
│ └──────────────────────────────────────────┘        │
│                                                      │
│ ┌──────────────────────────────────────────┐        │
│ │ Rust tokio Runtime (separate thread)     │        │
│ │ - Workflow orchestration                 │        │
│ │ - iii WebSocket connection               │        │
│ │ - State operations                       │        │
│ │ - DAG execution                          │        │
│ └──────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────┘
```

**Memory Overhead:**
- Node.js: ~50MB base
- Rust worker: ~10-20MB base
- Per workflow run: ~1-5KB
- **Total in-process:** ~60-70MB (vs 200MB+ separate Docker container)

### Best Practices für Nitro Plugins

```typescript
// server/plugins/workflow-worker.ts
import { WorkflowWorker } from '@nvent/worker'

let worker: WorkflowWorker | null = null

export default defineNitroPlugin(async (nitro) => {
  // ✅ Initialize worker once on startup
  worker = new WorkflowWorker({
    mode: 'function',
    iiiUrl: useRuntimeConfig().iii.url,
    shardId: 0,
    shardTotal: 1,
  })

  // ✅ Make available to all handlers
  nitro.hooks.hook('request', (event) => {
    event.context.workflowWorker = worker
  })

  // ✅ Graceful shutdown
  nitro.hooks.hook('close', async () => {
    await worker?.shutdown()
  })
})

// server/api/workflow/start.post.ts
export default defineEventHandler(async (event) => {
  const worker = event.context.workflowWorker
  const { definition, input } = await readBody(event)
  
  // ✅ Non-blocking: Returns immediately with run_id
  // Orchestration happens in Rust thread
  const runId = await worker.startWorkflow(
    JSON.stringify(definition),
    JSON.stringify(input)
  )
  
  return { runId }
})
```

### Load Test Beispiel

```typescript
// tests/load/workflow-worker.bench.ts
import { bench, describe } from 'vitest'
import { WorkflowWorker } from '@nvent/worker'

describe('Workflow Worker Performance', () => {
  const worker = new WorkflowWorker({ mode: 'function' })
  
  bench('start 100 workflows concurrently', async () => {
    const promises = Array.from({ length: 100 }, () =>
      worker.startWorkflow(definition, input)
    )
    
    await Promise.all(promises)
  })
  
  // Expected: <100ms for 100 concurrent starts
  // Node.js Event Loop should remain responsive
})
```

**Expected Performance:**
- ✅ 1000+ concurrent workflow starts/sec (single Nuxt instance)
- ✅ Node.js Event Loop latency: <1ms (unaffected)
- ✅ Memory: Linear growth (~1KB per run)

---

## 2.4 Comparison: In-Process vs External Worker

| Aspect | In-Process (napi-rs) | External (Docker) |
|--------|---------------------|-------------------|
| **Node.js Blocking** | ❌ No (async) | ❌ No (HTTP) |
| **Latency** | <1ms (in-memory) | 1-5ms (network) |
| **Memory** | ~70MB total | ~200MB+ per container |
| **HMR** | ✅ Instant | ⚠️ Container restart |
| **Development DX** | ✅✅✅ Excellent | ⚠️ Docker needed |
| **Production Scaling** | ⚠️ Limited to Nuxt replicas | ✅ Independent scaling |
| **Run Sharding** | ❌ Single instance | ✅ Multi-instance |

**Recommendation:**
- **Development:** In-process (beste DX, kein Docker)
- **Production (small scale):** In-process OK (<1000 workflows/hour)
- **Production (large scale):** External worker mit Run Sharding

### Real-World Scenario: Sarcopenia Analysis

```typescript
// server/api/study/[id]/analyze.post.ts
export default defineEventHandler(async (event) => {
  const studyId = getRouterParam(event, 'id')
  const worker = event.context.workflowWorker
  
  // ✅ START: Returns immediately (~500μs)
  // Node.js Event Loop bleibt frei
  const runId = await worker.startWorkflow(
    JSON.stringify({
      mode: 'function',
      nodes: {
        download: {
          executor: { Function: { function_id: 'dicom::download' } },
          input: { from: 'run_input' },
          depends_on: [],
        },
        segment: {
          executor: { Function: { function_id: 'segmentation::l3' } },
          input: { from: 'node:download' },
          depends_on: ['download'],
        },
        calculate: {
          executor: { Function: { function_id: 'sarcopenia::calculate-smi' } },
          input: { from: 'node:segment' },
          depends_on: ['segment'],
        },
      },
      output: { from: 'node:calculate' },
    }),
    JSON.stringify({ studyId })
  )
  
  // Response nach <1ms
  // Workflow läuft asynchron im Rust thread
  return {
    runId,
    status: 'running',
    _links: {
      status: `/api/workflow/${runId}/status`,
      stream: `/api/workflow/${runId}/stream`,
    }
  }
})

// Parallel requests werden NICHT blockiert:
// Request 1: POST /api/study/123/analyze  → runId: "run_abc" (<1ms)
// Request 2: POST /api/study/456/analyze  → runId: "run_xyz" (<1ms)
// Request 3: GET /api/studies               → [...] (<1ms)
//
// Alle 3 Requests werden parallel bearbeitet! ✅
// Rust tokio runtime orchestriert run_abc und run_xyz parallel
```

**Performance Messung:**
```typescript
// tools/benchmark.ts
import { performance } from 'node:perf_hooks'

async function benchmarkConcurrentStarts() {
  const start = performance.now()
  
  // 100 concurrent workflow starts
  const promises = Array.from({ length: 100 }, (_, i) =>
    $fetch('/api/study/analyze', {
      method: 'POST',
      body: { studyId: `study_${i}` }
    })
  )
  
  const results = await Promise.all(promises)
  const duration = performance.now() - start
  
  console.log(`✅ 100 concurrent starts: ${duration}ms`)
  console.log(`✅ Average per start: ${duration / 100}ms`)
  console.log(`✅ Throughput: ${100 / (duration / 1000)} starts/sec`)
  
  // Expected Output:
  // ✅ 100 concurrent starts: 50ms
  // ✅ Average per start: 0.5ms
  // ✅ Throughput: 2000 starts/sec
}
```

---

## 3. Erweiterte Features

### 3.1 Function-First Mode

**Current Official Worker:**
```rust
pub struct NodeDef {
    pub agent: AgentSpec,  // ← Braucht immer einen Agent!
    // ...
}
```

**Forked Worker Extension:**
```rust
pub enum NodeExecutor {
    Agent(AgentSpec),      // Original: Agent-based
    Function(FunctionSpec), // NEU: Direct function call
}

pub struct FunctionSpec {
    pub function_id: String,       // "analyze::sarcopenia"
    pub timeout_ms: Option<u64>,
    pub retry: Option<RetrySpec>,
}

pub struct NodeDef {
    pub executor: NodeExecutor,  // ← Flexibel!
    pub input: InputSpec,
    pub depends_on: Vec<String>,
    pub fanout: Option<FanoutSpec>,
}
```

**Workflow Definition:**
```json
{
  "nodes": {
    "analyze": {
      "executor": {
        "Function": {
          "function_id": "analyze::sarcopenia",
          "timeout_ms": 300000
        }
      },
      "input": { "from": "run_input" },
      "depends_on": []
    }
  }
}
```

**Benefits:**
- ✅ Kein Agent-Wrapper overhead
- ✅ Direkte Function-Calls
- ✅ Backward compatible (Agent mode bleibt)

---

### 3.2 Dynamic Execution Mode

**Neue Workflow Execution Modes:**

```rust
pub enum WorkflowMode {
    Dag,       // Original: Static DAG
    Dynamic,   // NEU: Runtime control flow
}

pub struct WorkflowDef {
    pub mode: WorkflowMode,
    pub nodes: BTreeMap<String, NodeDef>,
    pub control_flow: Option<ControlFlowSpec>,  // NEU
    // ...
}
```

#### Option A: Conditional Nodes (Einfach, DAG-Compatible)

```rust
pub struct ConditionalSpec {
    pub depends_on: String,       // "node:analyze"
    pub condition: String,         // "result.type == 'sarcopenia'"
    pub then_node: String,         // "sarcopenia-process"
    pub else_node: Option<String>, // "general-process"
}
```

**Beispiel:**
```json
{
  "mode": "dag",
  "nodes": {
    "analyze": { "executor": { "Function": { "function_id": "analyze::ct" } } },
    
    "branch": {
      "type": "conditional",
      "depends_on": ["analyze"],
      "condition": "analyze.result.type == 'sarcopenia'",
      "then_node": "sarcopenia-process",
      "else_node": "general-process"
    },
    
    "sarcopenia-process": { 
      "executor": { "Function": { "function_id": "sarcopenia::process" } },
      "depends_on": ["branch"]
    },
    
    "general-process": { 
      "executor": { "Function": { "function_id": "general::process" } },
      "depends_on": ["branch"]
    }
  }
}
```

**Implementation:**
```rust
impl WorkflowEngine {
    async fn tick_conditional_node(
        &self,
        node_id: &str,
        conditional: &ConditionalSpec,
        record: &mut WorkflowRunRecord,
        results: &BTreeMap<String, Value>,
    ) -> Result<TickDecision> {
        // Evaluate condition
        let dep_result = results.get(&conditional.depends_on)
            .ok_or("dependency not found")?;
        
        let condition_met = self.evaluate_condition(
            &conditional.condition, 
            dep_result
        )?;
        
        // Determine which branch to activate
        let next_node = if condition_met {
            &conditional.then_node
        } else {
            conditional.else_node.as_ref()
                .ok_or("else branch not defined")?
        };
        
        // Mark the NON-taken branch as Skipped
        let skipped_node = if condition_met {
            conditional.else_node.as_ref()
        } else {
            Some(&conditional.then_node)
        };
        
        if let Some(skip) = skipped_node {
            record.nodes.get_mut(skip).map(|cp| {
                cp.state = NodeState::Skipped;
            });
        }
        
        // Fire the taken branch
        Ok(TickDecision::Fire(vec![next_node.clone()]))
    }
}
```

**Vorteile:**
- ✅ DAG bleibt statisch (beide Branches zur Build-Zeit bekannt)
- ✅ Visualisierbar im UI
- ✅ Relativ einfach zu implementieren (~500 LOC)

---

#### Option B: Loop Nodes (Komplexer, State Machine)

```rust
pub struct LoopSpec {
    pub body_node: String,          // "fetch-page"
    pub condition: String,           // "result.hasMore == true"
    pub max_iterations: u32,         // Safety limit
    pub accumulator: Option<String>, // Optional: sammle Ergebnisse
}
```

**Beispiel:**
```json
{
  "mode": "dynamic",
  "nodes": {
    "fetch-loop": {
      "type": "loop",
      "body_node": "fetch-page",
      "condition": "result.hasMore == true",
      "max_iterations": 100
    },
    
    "fetch-page": {
      "executor": { "Function": { "function_id": "api::fetch-page" } },
      "input": { 
        "from": "loop_context",
        "template": "page={{iteration}}"
      }
    }
  }
}
```

**Implementation:**
```rust
pub struct LoopContext {
    pub iteration: u32,
    pub results: Vec<Value>,
    pub continue_loop: bool,
}

impl WorkflowEngine {
    async fn tick_loop_node(
        &self,
        node_id: &str,
        loop_spec: &LoopSpec,
        record: &mut WorkflowRunRecord,
    ) -> Result<TickDecision> {
        let ctx = self.get_loop_context(record, node_id)?;
        
        // Check termination
        if ctx.iteration >= loop_spec.max_iterations {
            return Ok(TickDecision::CompleteLoop);
        }
        
        // Evaluate condition (if iteration > 0)
        if ctx.iteration > 0 {
            let last_result = ctx.results.last()
                .ok_or("no previous result")?;
            
            let should_continue = self.evaluate_condition(
                &loop_spec.condition,
                last_result,
            )?;
            
            if !should_continue {
                return Ok(TickDecision::CompleteLoop);
            }
        }
        
        // Fire next iteration
        let iter_node_id = format!("{}#i{}", loop_spec.body_node, ctx.iteration);
        
        // Update context
        ctx.iteration += 1;
        self.save_loop_context(record, node_id, ctx)?;
        
        Ok(TickDecision::Fire(vec![iter_node_id]))
    }
}
```

**Vorteile:**
- ✅ Echte While-Loops möglich
- ✅ Dynamic iteration count
- ✅ Accumulated results

**Nachteile:**
- ⚠️ Komplexere Implementation (~1500 LOC)
- ⚠️ UI Visualisierung schwieriger (Graph ändert sich zur Runtime)
- ⚠️ Mehr State Management

---

### 3.3 Error Handling & Compensation

```rust
pub struct NodeDef {
    pub executor: NodeExecutor,
    pub on_error: Option<ErrorHandlerSpec>,  // NEU
    // ...
}

pub struct ErrorHandlerSpec {
    pub compensate_node: String,    // "refund-payment"
    pub max_retries: u32,            // Erst retries, dann compensation
    pub retry_backoff_ms: u64,
}
```

**Beispiel:**
```json
{
  "nodes": {
    "charge-payment": {
      "executor": { "Function": { "function_id": "payment::charge" } },
      "on_error": {
        "compensate_node": "refund-payment",
        "max_retries": 3,
        "retry_backoff_ms": 1000
      }
    },
    
    "refund-payment": {
      "executor": { "Function": { "function_id": "payment::refund" } },
      "input": { "from": "node:charge-payment.error" }
    }
  }
}
```

**Implementation:**
```rust
impl WorkflowEngine {
    async fn handle_node_failure(
        &self,
        node_id: &str,
        error: &str,
        record: &mut WorkflowRunRecord,
    ) -> Result<TickDecision> {
        let node_def = self.definition.nodes.get(node_id)
            .ok_or("node not found")?;
        
        let checkpoint = record.nodes.get_mut(node_id)
            .ok_or("checkpoint not found")?;
        
        if let Some(handler) = &node_def.on_error {
            // Check retry budget
            if checkpoint.retries < handler.max_retries {
                checkpoint.retries += 1;
                checkpoint.state = NodeState::Pending;
                checkpoint.pending_at = Some(now() + handler.retry_backoff_ms);
                
                return Ok(TickDecision::ScheduleRetry {
                    node_id: node_id.to_string(),
                    at: checkpoint.pending_at.unwrap(),
                });
            }
            
            // Retries exhausted → fire compensation
            let comp_node = &handler.compensate_node;
            
            // Store error context for compensation node
            record.compensation_context.insert(
                comp_node.clone(),
                CompensationContext {
                    failed_node: node_id.to_string(),
                    error: error.to_string(),
                    partial_result: checkpoint.result_ref.clone(),
                }
            );
            
            checkpoint.state = NodeState::Compensating;
            
            return Ok(TickDecision::Fire(vec![comp_node.clone()]));
        }
        
        // No handler → regular failure
        checkpoint.state = NodeState::Failed;
        Ok(TickDecision::Finalize(RunStatus::Failed))
    }
}
```

**Vorteile:**
- ✅ Declarative error handling
- ✅ Retry + Compensation pattern
- ✅ Try/Catch semantics ohne imperative code

---

## 3.4 Deployment Strategy Comparison ⚖️

### Option A: napi-rs In-Process Binding

**Architecture:**
```
┌─────────────────────────────────────┐
│ Nuxt/Nitro Process                  │
│ ┌─────────────────────────────────┐ │
│ │ Node.js                         │ │
│ │ ┌─────────────────────────────┐ │ │
│ │ │ @nvent/worker (Rust)        │ │ │
│ │ │ via napi-rs                 │ │ │
│ │ └─────────────────────────────┘ │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

**Vorteile:**
- ✅ Ultra-low latency (<1ms)
- ✅ Kein separater Process in Development
- ✅ Shared memory (effizient)

**Nachteile:**
- ⚠️ Platform-specific builds (Linux/Mac/Windows)
- ⚠️ Komplexe Build chain (Rust + napi-rs)
- ⚠️ Debugging schwieriger (Rust + Node.js)
- ⚠️ Memory im Nuxt process (kann problematisch werden)
- ⚠️ Kein Run Sharding (single instance)
- ⚠️ Inconsistent mit iii Architektur (nicht über engine)

---

### Option B: Separate iii Worker (✅ EMPFEHLUNG)

**Architecture:**
```
┌────────────────────────────────────────────────────┐
│ iii Engine                                         │
│                                                     │
│ ┌──────────────────┐  ┌───────────────────────┐   │
│ │ Nuxt Worker      │  │ Workflow Worker (Rust)│   │
│ │                  │  │                       │   │
│ │ Functions:       │  │ Functions:            │   │
│ │ - analyze::*     │  │ - workflow::start     │   │
│ │ - payment::*     │  │ - workflow::tick      │   │
│ │ - dicom::*       │  │ - workflow::status    │   │
│ └──────────────────┘  └───────────────────────┘   │
└────────────────────────────────────────────────────┘
```

**Implementation:**

```typescript
// Nuxt ruft workflow::start wie jede andere Function
export default defineEventHandler(async (event) => {
  const { definition, input } = await readBody(event)
  
  // ✅ Nutzt iii engine - konsistent mit allen anderen Functions!
  const result = await iii.trigger({
    function_id: 'workflow::start',
    payload: { definition, input }
  })
  
  return { runId: result.run_id }
})
```

```rust
// Rust Worker (separate Binary)
// packages/workflow-worker/src/main.rs
use iii_sdk::{Worker, FunctionHandler};

#[tokio::main]
async fn main() {
    let worker = Worker::new("workflow-worker")
        .register("workflow::start", start_workflow)
        .register("workflow::tick", tick_workflow)
        .register("workflow::status", get_status)
        .build()
        .await;
    
    worker.run().await;
}

async fn start_workflow(input: WorkflowStartInput) -> Result<WorkflowStartOutput> {
    let engine = WorkflowEngine::new()?;
    let run_id = engine.start(input.definition, input.input).await?;
    Ok(WorkflowStartOutput { run_id })
}
```

**Vorteile:**
- ✅ **Einfachste Implementation** (kein napi-rs!)
- ✅ **Konsistent mit iii Architektur** (alles über engine)
- ✅ **Run Sharding works out-of-the-box** (wie bei jedem iii Worker)
- ✅ **Einfaches Deployment** (einfach ein Worker mehr)
- ✅ **Development:** `cargo watch --exec run` (hot reload!)
- ✅ **Keine platform-specific builds** (cross-compilation optional)
- ✅ **Isolierte Prozesse** (kein Memory-Konflikt mit Nuxt)
- ✅ **Debugging einfacher** (separate logs, kein mixed stack)
- ✅ **Horizontal scaling** wie jeder andere Worker

**Nachteile:**
- ⚠️ Latency: 1-5ms statt <1ms (über WebSocket/engine)
- ⚠️ Ein zusätzlicher Process (aber das ist bei iii normal)

**Performance Vergleich:**

| Operation | napi-rs | iii Worker | Delta |
|-----------|---------|------------|-------|
| workflow::start | 0.3ms | 2ms | +1.7ms |
| workflow::tick | 0.2ms | 1.5ms | +1.3ms |
| workflow::status | 0.1ms | 1ms | +0.9ms |

**Für Sarcopenia Workflow (5min Gesamtdauer):**
- napi-rs: 5:00.003 (3ms overhead)
- iii worker: 5:00.010 (10ms overhead)
- **Unterschied: 7ms bei 5 Minuten → 0.002% ⚠️ IRRELEVANT!**

---

### ✅ Empfehlung: Option B (Separate iii Worker)

**Warum:**
1. **Konsistenz:** Alles läuft über iii engine (Functions, State, Queue, **Workflows**)
2. **Simplicity:** Kein napi-rs, keine platform builds, kein mixed debugging
3. **Scalability:** Run Sharding funktioniert wie bei jedem Worker
4. **Development:** `cargo run` oder `cargo watch` - kein Docker nötig!
5. **Performance:** 1-5ms Overhead ist bei Workflow-Dauer (Sekunden/Minuten) irrelevant

**Development Setup:**

```bash
# Terminal 1: iii engine
docker compose up iii-engine

# Terminal 2: Nuxt server
pnpm dev

# Terminal 3: Workflow worker (Rust)
cd packages/workflow-worker
cargo watch --exec run
# ✅ Auto-reload bei Code-Änderungen!
```

**Production Setup:**

```yaml
# docker-compose.yml
services:
  iii-engine:
    image: ghcr.io/iii-hq/engine:latest
  
  nuxt-worker:
    build: .
    environment:
      - III_URL=ws://iii-engine:49134
  
  workflow-worker-0:
    image: ghcr.io/nvent/workflow-worker:latest
    environment:
      - III_URL=ws://iii-engine:49134
      - SHARD_ID=0
      - SHARD_TOTAL=3
  
  workflow-worker-1:
    image: ghcr.io/nvent/workflow-worker:latest
    environment:
      - III_URL=ws://iii-engine:49134
      - SHARD_ID=1
      - SHARD_TOTAL=3
  
  workflow-worker-2:
    image: ghcr.io/nvent/workflow-worker:latest
    environment:
      - III_URL=ws://iii-engine:49134
      - SHARD_ID=2
      - SHARD_TOTAL=3
```

**Simplified Package Structure:**

```
packages/
  workflow-worker/        # Rust binary (separate)
    ├── src/
    │   ├── main.rs       # iii Worker registration
    │   ├── engine.rs     # Forked from iii-hq/workers
    │   ├── function_mode.rs
    │   └── dynamic_mode.rs
    ├── Cargo.toml
    └── Dockerfile
  
  nvent/                  # Nuxt module
    ├── src/
    │   ├── module.ts     # Compiler: defineWorkflow → DAG
    │   └── runtime/
    │       └── workflow.ts   # iii.trigger('workflow::start')
```

**Kein napi-rs Package nötig!** ✅

---

## 4. Architecture (Updated for Option B)

### 4.1 Package Structure

```
packages/
  workflow-worker/              # ✅ Separate Rust Binary (iii Worker)
    ├── src/
    │   ├── main.rs              # iii Worker registration
    │   ├── functions/
    │   │   ├── start.rs         # workflow::start handler
    │   │   ├── tick.rs          # workflow::tick handler
    │   │   └── status.rs        # workflow::status handler
    │   ├── engine/
    │   │   ├── mod.rs           # Core engine (forked from iii-hq)
    │   │   ├── dag.rs           # Original DAG logic
    │   │   ├── function_mode.rs # NEU: Function executor
    │   │   ├── dynamic_mode.rs  # NEU: Dynamic control flow
    │   │   ├── conditional.rs   # NEU: Conditional nodes
    │   │   ├── loops.rs         # NEU: Loop nodes
    │   │   └── compensation.rs  # NEU: Error handlers
    │   └── types.rs
    ├── Cargo.toml
    ├── Dockerfile
    └── README.md

  nvent/                        # Nuxt Module
    ├── src/
    │   ├── module.ts            # Nuxt module
    │   ├── compiler/
    │   │   └── workflow.ts      # defineWorkflow → DAG format
    │   └── runtime/
    │       └── workflow.ts      # iii.trigger('workflow::start')
    ├── package.json
    └── README.md
```

### 4.2 Deployment Modes (Using iii Worker Approach)

#### Development Mode 🚀

**Setup:**
```bash
# Terminal 1: iii engine
docker compose up iii-engine

# Terminal 2: Nuxt server
pnpm dev

# Terminal 3: Workflow worker (hot reload!)
cd packages/workflow-worker
cargo watch --exec run
```

**Architecture:**
```
┌────────────────────────────────────────┐
│ iii Engine (WebSocket Coordinator)    │
│                                         │
│ ┌───────────────┐  ┌─────────────────┐│
│ │ Nuxt Worker   │  │ Workflow Worker ││
│ │ (Node.js)     │  │ (Rust)          ││
│ │               │  │                 ││
│ │ - analyze::*  │  │ - workflow::*   ││
│ └───────────────┘  └─────────────────┘│
└────────────────────────────────────────┘
```

**Nuxt Usage:**
```typescript
// server/api/workflow/start.post.ts
export default defineEventHandler(async (event) => {
  const { definition, input } = await readBody(event)
  
  // ✅ Ruft workflow::start über iii engine auf
  const result = await iii.trigger({
    function_id: 'workflow::start',
    payload: { definition, input }
  })
  
  return { runId: result.run_id }
})
```

**Workflow Worker:**
```rust
// packages/workflow-worker/src/main.rs
use iii_sdk::{Worker, Context};

#[tokio::main]
async fn main() {
    let worker = Worker::new("workflow-worker")
        .function("workflow::start", start_workflow)
        .function("workflow::tick", tick_workflow)
        .function("workflow::status", get_status)
        .build()
        .await
        .unwrap();
    
    println!("✅ Workflow worker running");
    println!("   - workflow::start");
    println!("   - workflow::tick");
    println!("   - workflow::status");
    
    worker.run().await.unwrap();
}

async fn start_workflow(
    ctx: Context,
    input: WorkflowStartInput,
) -> Result<WorkflowStartOutput> {
    let engine = WorkflowEngine::new()?;
    let run_id = engine.start(input.definition, input.input).await?;
    
    // Trigger first tick
    ctx.trigger("workflow::tick", json!({ "run_id": run_id })).await?;
    
    Ok(WorkflowStartOutput { run_id })
}
```

**Vorteile:**
- ✅ Kein napi-rs complexity
- ✅ `cargo watch` hot reload (auto-restart on code change)
- ✅ Separate logs (Rust worker in eigener shell)
- ✅ Konsistent mit iii Architektur
- ✅ Run Sharding später einfach hinzufügen

---

#### Production Mode 🏭

**Docker Compose:**
```yaml
# docker-compose.yml
services:
  iii-engine:
    image: ghcr.io/iii-hq/engine:latest
    ports:
      - "49134:49134"
    environment:
      - REDIS_URL=redis://redis:6379
  
  redis:
    image: redis:7-alpine
  
  nuxt-app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - III_URL=ws://iii-engine:49134
  
  # Workflow Worker mit Run Sharding (3 Shards)
  workflow-worker-0:
    image: ghcr.io/nvent/workflow-worker:latest
    environment:
      - III_URL=ws://iii-engine:49134
      - WORKER_NAME=workflow-worker-0
      - SHARD_ID=0
      - SHARD_TOTAL=3
    deploy:
      replicas: 1
  
  workflow-worker-1:
    image: ghcr.io/nvent/workflow-worker:latest
    environment:
      - III_URL=ws://iii-engine:49134
      - WORKER_NAME=workflow-worker-1
      - SHARD_ID=1
      - SHARD_TOTAL=3
    deploy:
      replicas: 1
  
  workflow-worker-2:
    image: ghcr.io/nvent/workflow-worker:latest
    environment:
      - III_URL=ws://iii-engine:49134
      - WORKER_NAME=workflow-worker-2
      - SHARD_ID=2
      - SHARD_TOTAL=3
    deploy:
      replicas: 1
```

**Dockerfile:**
```dockerfile
# packages/workflow-worker/Dockerfile
FROM rust:1.76 as builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/workflow-worker /usr/local/bin/
EXPOSE 8080
CMD ["workflow-worker"]
```

**Vorteile:**
- ✅ Run Sharding funktioniert automatisch (iii engine macht consistent hashing)
- ✅ Horizontal scaling (einfach SHARD_TOTAL erhöhen)
- ✅ Isoliert von Nuxt (separate containers)
- ✅ Standard iii Worker deployment (wie alle anderen auch)

---

## 5. Implementation Roadmap (Updated for iii Worker Approach)

### Phase 1: Fork + Basic iii Worker Setup (Week 1-2) 🔧

**Tasks:**
- [ ] Fork `iii-hq/workers/workflow` to `nvent/workflow-worker`
- [ ] Create Rust binary project structure
- [ ] Implement basic iii Worker registration (workflow::start, workflow::tick, workflow::status)
- [ ] Integration tests: Fork verhält sich wie Original (DAG mode)
- [ ] Development setup: `cargo watch` hot reload
- [ ] CI Pipeline: Build Docker image

**Deliverable:** `workflow-worker@0.1.0` - Basic iii Worker with DAG support

**Code Example:**
```rust
// packages/workflow-worker/src/main.rs
#[tokio::main]
async fn main() {
    let worker = iii_sdk::Worker::new("workflow-worker")
        .function("workflow::start", handlers::start_workflow)
        .function("workflow::tick", handlers::tick_workflow)
        .function("workflow::status", handlers::get_status)
        .build()
        .await
        .unwrap();
    
    worker.run().await.unwrap();
}
```

**Test:**
```typescript
// Test from Nuxt
const result = await iii.trigger({
  function_id: 'workflow::start',
  payload: {
    definition: { /* DAG */ },
    input: { studyId: '123' }
  }
})
// ✅ Should work like official worker
```

---

### Phase 2: Function-First Mode (Week 3-4) ⚡

**Tasks:**
- [ ] Extend `NodeDef` with `NodeExecutor::Function`
- [ ] Implement function execution logic (call iii functions directly)
- [ ] Update nvent compiler: `ctx.step()` → Function node
- [ ] Tests: Function workflows end-to-end
- [ ] Documentation

**Deliverable:** Function workflows ohne Agent-Overhead

**Code Example:**
```rust
// Support both Agent and Function executors
pub enum NodeExecutor {
    Agent(AgentSpec),      // Original
    Function(FunctionSpec), // NEU
}

async fn execute_node(executor: &NodeExecutor, input: Value) -> Result<Value> {
    match executor {
        NodeExecutor::Agent(spec) => {
            // Original: Create harness session
            execute_agent_node(spec, input).await
        }
        NodeExecutor::Function(spec) => {
            // NEU: Direct iii function call
            ctx.trigger(spec.function_id, input).await
        }
    }
}
```

---

### Phase 3: Conditional Nodes (Week 5-6) 🔀

**Tasks:**
- [ ] Implement `ConditionalSpec`
- [ ] Condition evaluator (JSONPath or simple DSL)
- [ ] Branch selection logic
- [ ] Skip non-taken branches
- [ ] Update nvent compiler for if/else
- [ ] Tests: conditional workflows

**Deliverable:** `if/else` control flow in workflows

---

### Phase 4: Error Handlers (Week 7-8) 🛡️

**Tasks:**
- [ ] Implement `ErrorHandlerSpec`
- [ ] Compensation node triggering
- [ ] Retry logic with backoff
- [ ] Error context passing
- [ ] Tests: compensation workflows

**Deliverable:** Try/catch pattern in workflows

---

### Phase 5: Loop Nodes (Week 9-12) 🔄 (Optional)

**Tasks:**
- [ ] Implement `LoopSpec` and `LoopContext`
- [ ] Dynamic node generation for iterations
- [ ] Loop termination logic
- [ ] Result accumulation
- [ ] UI updates for dynamic graphs
- [ ] Tests: while-loop workflows

**Deliverable:** While loops in workflows

---

### Phase 6: Production Optimization (Week 13-14) 🏭

**Tasks:**
- [ ] Run Sharding configuration
- [ ] Docker Compose production setup (3+ shards)
- [ ] Kubernetes manifests
- [ ] Load tests
- [ ] Monitoring & observability setup

**Deliverable:** Production-ready deployment with horizontal scaling

---

## 6. Comparison Matrix (Updated)

| Feature | Official Worker | Fork as iii Worker | Fork with napi-rs | TypeScript Worker |
|---------|----------------|--------------------|--------------------|-------------------|
| **DAG Orchestration** | ✅ Battle-tested | ✅ Inherited | ✅ Inherited | ⚠️ Selbst bauen |
| **Run Sharding** | ✅ Included | ✅ iii engine handles it | ⚠️ Complex | ⚠️ Selbst bauen |
| **Idempotency** | ✅ Included | ✅ Inherited | ✅ Inherited | ⚠️ Selbst bauen |
| **Agent Support** | ✅ Native | ✅ Native | ✅ Native | ❌ |
| **Function Calls** | ⚠️ Via wrapper | ✅ Native | ✅ Native | ✅ Native |
| **Conditional Branches** | ❌ | ✅ Custom | ✅ Custom | ✅ Custom |
| **Loops** | ❌ | ✅ Custom | ✅ Custom | ✅ Custom |
| **Error Handlers** | ⚠️ Basic | ✅ Compensation | ✅ Compensation | ✅ Compensation |
| **Latency** | 1-5ms | 1-5ms | <1ms | 1-5ms |
| **Dev Setup** | Docker | `cargo run` | `pnpm dev` | `pnpm dev` |
| **Hot Reload** | ❌ | ✅ cargo watch | ✅ HMR | ✅ HMR |
| **Deployment** | Docker | Docker | Binary in Node | Docker |
| **Complexity** | Low | **Low** ⭐ | High | Medium |
| **iii Consistency** | ✅ | ✅ ⭐ | ⚠️ | ⚠️ |
| **Maintenance** | iii Team | Fork sync | Fork sync + napi-rs | Full ownership |
| **Performance** | ✅✅✅ | ✅✅✅ | ✅✅✅ | ✅✅ |
| **Initial Effort** | 0 days | **2-3 weeks** ⭐ | 3-4 weeks | 4-6 weeks |
| **Ongoing Effort** | 0 | **1-2 days/month** ⭐ | 2-3 days/month | 3-5 days/month |

**⭐ Winner: Fork as iii Worker**

---

## 7. Risks & Mitigation

### Risk 1: Fork Divergence 🌳
**Problem:** Official worker bekommt breaking changes, unser Fork ist inkompatibel

**Mitigation:**
- ✅ Monthly upstream sync schedule
- ✅ Automated conflict detection in CI
- ✅ Keep extensions modular (separate files)
- ✅ Feature flags für custom features

### Risk 2: napi-rs Compatibility Issues 🔌
**Problem:** Platform-spezifische build failures, debugging schwierig

**Mitigation:**
- ✅ CI builds für alle Platforms (Linux/Mac/Windows x64/ARM)
- ✅ Prebuilt binaries in npm package
- ✅ Fallback to external worker mode wenn napi-rs fails
- ✅ Comprehensive error messages

### Risk 3: Rust Expertise Gap 👨‍💻
**Problem:** Team kennt Rust nicht gut genug für Wartung

**Mitigation:**
- ✅ Code-Review mit Rust experts
- ✅ Dokumentation aller custom features
- ✅ Rust training für Team
- ✅ Community support (Rust Discord, Forums)

### Risk 4: Performance Regression 📉
**Problem:** Custom features langsamer als Original

**Mitigation:**
- ✅ Benchmark suite from day 1
- ✅ Performance tests in CI
- ✅ Profiling tools (flamegraph)
- ✅ Keep hot paths unchanged from original

---

## 8. Decision Framework

### Wann Fork + napi-rs nutzen? ✅

**USE wenn:**
- ✅ Du brauchst >2 der extended features (conditional, loops, compensation)
- ✅ Team ist bereit Rust zu lernen/maintainen
- ✅ In-process mode ist wichtig (Development DX)
- ✅ Performance ist kritisch (Rust > Node.js)
- ✅ Budget für 2-3 Wochen initial setup

### Wann NICHT nutzen? ❌

**AVOID wenn:**
- ❌ Official worker reicht aus (nur basic DAG)
- ❌ Kein Rust-Expertise im Team
- ❌ Keine Zeit für Fork maintenance
- ❌ Nur 1-2 simple workflows
- ❌ Externe Dependencies problematisch (Corporate Policy)

---

## 9. Alternative: Contribute Upstream 🤝

**Statt Fork:** Features zum official worker beitragen

**Vorteile:**
- ✅ Kein Fork maintenance
- ✅ Community profitiert
- ✅ iii Team reviewed Code
- ✅ Automatische Updates

**Process:**
1. RFC/Issue beim iii Team erstellen
2. Design mit Maintainern diskutieren
3. PR mit Feature implementieren
4. Review + Merge
5. Release in official worker

**Timeframe:** 2-4 Monate (langsamer als Fork, aber nachhaltiger)

**Empfehlung:**
- **Conditional Nodes:** Hohe Chance auf Acceptance ✅
- **Error Handlers:** Mittlere Chance ⚠️
- **Loop Nodes:** Niedrige Chance (breaks DAG paradigm) ❌

---

## 10. Recommended Strategy

### 🎯 Drei-Phasen Ansatz:

#### Phase 1: Start with Official Worker (Month 1)
```typescript
// Nutze official worker mit Agent-Wrapper
// 80% der Use Cases abgedeckt
defineWorkflow({
  handler: async (input, ctx) => {
    return await ctx.step('analyze', input);
  }
});
```

#### Phase 2: Evaluate Fork (Month 2-3)
- **IF** Agent-Wrapper overhead zu groß → Fork + Function-Mode
- **IF** Conditionals/Loops gebraucht → Fork + Dynamic Mode
- **IF** Official worker ausreichend → Weiter nutzen

#### Phase 3a: Fork + napi-rs (Month 3-4)
- Setup fork mit extended features
- Migration path dokumentieren
- Production deployment

#### Phase 3b: Contribute Upstream (Month 3-6)
- RFC für Features beim iii Team
- Community Feedback
- Eventual merge in official worker

---

## 11. Proof of Concept

### Minimal PoC Scope (1 Week)

**Goal:** Validate napi-rs + Fork funktioniert

```rust
// packages/worker-poc/rust/src/lib.rs
#![deny(clippy::all)]

use napi_derive::napi;

#[napi]
pub struct WorkflowWorker {
    inner: String,
}

#[napi]
impl WorkflowWorker {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: "poc".to_string() }
    }

    #[napi]
    pub fn hello(&self, name: String) -> String {
        format!("Hello {} from Rust!", name)
    }

    #[napi]
    pub async fn start_workflow(&self, definition: String) -> String {
        // Minimal: Just return a run_id
        format!("run_{}", uuid::Uuid::new_v4())
    }
}
```

**Test:**
```typescript
import { WorkflowWorker } from '@nvent/worker-poc'

const worker = new WorkflowWorker()
console.log(worker.hello('nvent'))  // "Hello nvent from Rust!"

const runId = await worker.startWorkflow('{"nodes":{}}')
console.log(runId)  // "run_123e4567-e89b-12d3-a456-426614174000"
```

**Success Criteria:**
- ✅ Builds on Linux/Mac/Windows
- ✅ Async functions work
- ✅ JSON passing works
- ✅ No memory leaks

**Deliverable:** Go/No-Go decision für full implementation

---

## 12. Cost-Benefit Analysis

### Costs 💰

| Item | Effort | Annual |
|------|--------|--------|
| **Initial Setup** | 2-3 weeks | - |
| **Function Mode** | 2 weeks | - |
| **Conditional Nodes** | 2 weeks | - |
| **Error Handlers** | 2 weeks | - |
| **Monthly Maintenance** | 1-2 days | 12-24 days/year |
| **Rust Training** | 1 week per dev | - |
| **Total Year 1** | ~12 weeks | - |

### Benefits ✅

| Benefit | Value |
|---------|-------|
| **Performance** | Rust vs Node.js (10-50x faster) |
| **Flexibility** | Conditional + Loops + Compensation |
| **DX** | In-process mode (instant HMR) |
| **Type Safety** | Rust compiler catches bugs |
| **Scalability** | Inherited run sharding |
| **Future-Proof** | Control über Features |

**Break-Even:** ~3-4 Monate bei aktiver Nutzung

---

## 13. Conclusion & Recommendation

### ✅ **EMPFEHLUNG: Fork als iii Worker** ⭐

**Warum das die beste Lösung ist:**

1. ✅ **Maximale Simplicity:** Kein napi-rs, kein platform-specific builds, kein mixed debugging
2. ✅ **Konsistent mit iii:** Alles läuft über iii engine - Functions, State, Queue, **Workflows**
3. ✅ **Battle-tested Core:** Inherit DAG, Run Sharding, Idempotency vom official worker
4. ✅ **Excellent DX:** `cargo watch --exec run` für hot reload in Development
5. ✅ **Production-Ready:** Run Sharding funktioniert out-of-the-box (iii engine macht's)
6. ✅ **Wartbar:** Fork sync 1-2 Tage/Monat, keine napi-rs Komplexität
7. ✅ **Performance ist irrelevant:** 1-5ms Latency bei Workflows die Minuten dauern = 0.002% Overhead

**Vergleich:**

| Aspekt | napi-rs | **iii Worker** ⭐ |
|--------|---------|------------------|
| Latency | 0.3ms | 2ms (+1.7ms) |
| **Bei 5min Workflow** | **5:00.003** | **5:00.010** (+7ms = 0.002%) |
| Complexity | High | **Low** ✅ |
| Dev Setup | pnpm dev | **cargo watch** ✅ |
| Hot Reload | HMR | **cargo watch** ✅ |
| Run Sharding | Complex | **Automatic** ✅ |
| iii Consistency | ⚠️ | **✅** ⭐ |
| Platform Builds | Required | **Optional** ✅ |
| Debugging | Mixed | **Separate** ✅ |

**Praktischer Vergleich:**

```typescript
// ❌ napi-rs: Komplexe Build chain
import { WorkflowWorker } from '@nvent/worker'  // ← Needs Rust + napi-rs build
const worker = new WorkflowWorker()
const runId = worker.startWorkflow(def)  // 0.3ms

// ✅ iii Worker: Einfach, konsistent
const result = await iii.trigger({        // ← Standard iii pattern
  function_id: 'workflow::start',
  payload: { definition, input }
})  // 2ms (+1.7ms, aber bei 5min workflow irrelevant!)
```

**Next Steps:**

### Week 1-2: Fork Setup + Basic Worker 🔧
```bash
# 1. Fork repo
git clone https://github.com/iii-hq/workers.git
cd workers/workflow

# 2. Create iii worker wrapper
cargo new --bin workflow-worker
# Implement iii SDK registration

# 3. Test
cargo run
# ✅ Registriert workflow::start, workflow::tick, workflow::status
```

### Week 3-4: Function-First Mode ⚡
```rust
// Add NodeExecutor::Function support
pub enum NodeExecutor {
    Agent(AgentSpec),
    Function(FunctionSpec),  // ← NEU
}
```

### Week 5-6: Conditional Nodes 🔀
```json
{
  "type": "conditional",
  "condition": "result.type == 'sarcopenia'",
  "then_node": "sarcopenia-process"
}
```

### Week 7-8: Error Handlers 🛡️
```json
{
  "on_error": {
    "compensate_node": "refund",
    "max_retries": 3
  }
}
```

### Month 3: Production 🏭
```yaml
workflow-worker:
  image: ghcr.io/nvent/workflow-worker:latest
  replicas: 3
  environment:
    - SHARD_ID=0-2
```

**Alternative Path:** 
- Wenn Rust expertise fehlt → TypeScript Worker
- Wenn Performance wirklich kritisch → napi-rs
- **Aber:** Für 99% der Use Cases ist **iii Worker optimal** ✅

---

## 14. Open Questions

- [ ] **Q:** Brauchen wir gRPC statt HTTP für external mode?
- [ ] **Q:** Welche Condition Expression Language? (JSONPath, CEL, Custom DSL?)
- [ ] **Q:** Loop Nodes in Phase 1 oder später?
- [ ] **Q:** Wollen wir eventual upstream contribution?
- [ ] **Q:** Platform support: Nur Linux oder auch Windows?

---

**Status:** Ready for decision  
**Recommendation:** ✅ **Go ahead with 1-week PoC**  
**Risk Level:** 🟡 Medium (manageable with good planning)  
**Impact:** 🟢 High (enables 100% feature coverage)
