# Workflow Metadata Tracking - Design Document

**Status**: 🏗️ Implementation  
**Date**: 2026-07-14  
**Goal**: Enhanced metadata tracking for workflow UI and observability

---

## 1. Current State Analysis

### 1.1 Existing Metadata

**WorkflowRunRecord** (stored in `workflow_run` scope):
```rust
{
  run_id: String,
  status: RunStatus,
  created_at: i64,      // ✅ Has
  updated_at: i64,      // ✅ Has
  caller_session_id: Option<String>  // ✅ Has
}
```

**NodeCheckpoint** (per-node state):
```rust
{
  state: NodeState,
  session_id: Option<String>,
  turn_id: Option<String>,
  pending_at: Option<i64>,  // ✅ Has start time
  retries: u32
}
```

### 1.2 Missing Metadata

❌ Worker name (which worker is executing)  
❌ Runtime type (nodejs/python/rust)  
❌ Function metadata in definition  
❌ Node completion timestamp  
❌ Node execution duration  
❌ Function execution context  

---

## 2. Architecture Decision: Hybrid Approach

### 2.1 State Store (for UI & Recovery)

**Use for:**
- Worker identification
- Runtime type classification
- Function metadata
- Execution timestamps (start, complete)
- Status tracking

**Why:**
- ✅ Direct UI queries (fast)
- ✅ Persistent & recoverable
- ✅ Consistent with current architecture
- ✅ No additional infrastructure

### 2.2 Telemetry/Observability (for Monitoring)

**Use for:**
- Performance metrics (duration, latency)
- Tracing (distributed traces across functions)
- Error rates & retry patterns
- Resource usage

**Why:**
- ✅ Built for time-series data
- ✅ Better performance analysis
- ✅ Already integrated (OpenTelemetry)
- ✅ Doesn't bloat state storage

### 2.3 Trade-offs

| Concern | State Store | Telemetry |
|---------|-------------|-----------|
| UI Query Speed | ⚡ Fast | 🐌 Slower |
| Storage Cost | 💰 Higher | 💰 Lower |
| Time-series Analysis | ❌ Poor | ✅ Excellent |
| Recovery/Replay | ✅ Full data | ⚠️ May expire |
| Implementation | ✅ Simple | ⚠️ Complex |

**Decision**: Store **essential UI metadata** in state, emit **performance metrics** to telemetry.

---

## 3. Implementation Design

### 3.1 Enhanced WorkflowDef Schema

Add metadata to the definition itself (stored once, never changes):

```rust
// packages/workflow-worker/src/types.rs

pub struct WorkflowDef {
    pub version: u32,
    pub nodes: BTreeMap<String, NodeDef>,
    pub output: OutputRef,
    
    // ✨ NEW: Metadata
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<WorkflowMetadata>,
}

pub struct WorkflowMetadata {
    /// Worker that created this workflow (e.g. "nvent-python-12345")
    pub created_by_worker: Option<String>,
    
    /// User-friendly workflow name (e.g. "AI Content Pipeline")
    pub name: Option<String>,
    
    /// Optional description
    pub description: Option<String>,
    
    /// Tags for categorization
    #[serde(default)]
    pub tags: Vec<String>,
}
```

### 3.2 Enhanced NodeDef Schema

Add function runtime info to each node:

```rust
pub struct NodeDef {
    pub function: FunctionSpec,
    pub input: InputSpec,
    pub depends_on: Vec<String>,
    pub fanout: Option<FanoutSpec>,
}

pub struct FunctionSpec {
    pub id: String,
    pub timeout_ms: Option<u64>,
    
    // ✨ NEW: Runtime metadata
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<FunctionRuntime>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FunctionRuntime {
    NodeJS,
    Python,
    Rust,
    Unknown,
}
```

### 3.3 Enhanced NodeCheckpoint

Add execution timing to node state:

```rust
pub struct NodeCheckpoint {
    pub state: NodeState,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub retries: u32,
    
    // ✨ EXISTING (keep)
    pub pending_at: Option<i64>,  // Start time
    pub pending_timeout_ms: Option<u64>,
    
    // ✨ NEW: Completion tracking
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,  // End time
    
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_name: Option<String>,  // Worker that executed this node
}
```

### 3.4 Runtime Metadata Injection

#### Node.js Functions

```typescript
// packages/nvent/src/runtime/nitro/utils/workers/node.ts

export function registerNodeFunctions(iii: IIIClient, fns: NodeFnInfo[]): void {
  for (const fn of fns) {
    const wrappedHandler = async (input: unknown) => {
      const workflow = (input as any)?._workflow
      const hasWorkflowMeta = workflow?.run_id && workflow?.node_uid
      
      if (hasWorkflowMeta) {
        // ✨ NEW: Inject worker name
        await iii.trigger({
          function_id: 'state::set',
          payload: {
            scope: 'workflow_node_metadata',
            key: `${workflow.run_id}/${workflow.node_uid}`,
            value: {
              worker_name: `nvent-nodejs-${process.pid}`,
              runtime: 'nodejs',
              started_at: Date.now(),
            },
          },
        })
      }
      
      const result = await fn.handler(actualInput)
      
      if (hasWorkflowMeta) {
        // Update with completion time
        await iii.trigger({
          function_id: 'state::set',
          payload: {
            scope: 'workflow_node_metadata',
            key: `${workflow.run_id}/${workflow.node_uid}`,
            value: {
              worker_name: `nvent-nodejs-${process.pid}`,
              runtime: 'nodejs',
              started_at: Date.now(), // Re-fetch from state in real impl
              completed_at: Date.now(),
            },
          },
        })
        
        // ✨ NEW: Emit telemetry
        console.log(`[nvent/telemetry] node ${workflow.node_uid} executed in ${Date.now() - workflow.started_at}ms`)
      }
      
      return result
    }
    
    // ... rest of registration
  }
}
```

#### Python Functions

```python
# packages/nvent/src/runtime/python/worker_runtime.py

def _register_one(client, mod, default_id: str, fn_def: dict) -> None:
    handler = fn_def["handler"]
    
    async def wrapped_handler(payload):
        workflow = payload.get("_workflow")
        if workflow and workflow.get("run_id") and workflow.get("node_uid"):
            # ✨ NEW: Inject worker metadata
            await client.trigger({
                "function_id": "state::set",
                "payload": {
                    "scope": "workflow_node_metadata",
                    "key": f"{workflow['run_id']}/{workflow['node_uid']}",
                    "value": {
                        "worker_name": client.worker_name,
                        "runtime": "python",
                        "started_at": int(time.time() * 1000),
                    },
                },
            })
        
        result = await handler(payload.get("input", payload))
        
        if workflow:
            # Update with completion
            await client.trigger({
                "function_id": "state::set",
                "payload": {
                    "scope": "workflow_node_metadata",
                    "key": f"{workflow['run_id']}/{workflow['node_uid']}",
                    "value": {
                        "completed_at": int(time.time() * 1000),
                    },
                },
            })
        
        return result
    
    client.register_function(default_id, wrapped_handler)
```

#### Rust Workflow Worker

```rust
// packages/workflow-worker/src/functions/tick.rs

pub(crate) async fn fire_node(
    deps: &Deps,
    record: &mut WorkflowRunRecord,
    def: &WorkflowDef,
    node_uid: &str,
    results: &BTreeMap<String, Value>,
) -> Result<(), WorkflowError> {
    // ... existing code ...
    
    // ✨ NEW: Update checkpoint with worker info
    let checkpoint = record.nodes.entry(node_uid.to_string()).or_insert_with(|| {
        NodeCheckpoint {
            state: NodeState::Running,
            session_id: None,
            turn_id: None,
            pending_at: Some(deps.now_ms()),
            pending_timeout_ms: node.function.timeout_ms,
            retries: attempt,
            result_ref: None,
            result_error: None,
            completed_at: None,  // ✨ NEW
            worker_name: Some("workflow-orchestrator".to_string()),  // ✨ NEW
        }
    });
    
    // ... dispatch logic ...
}
```

### 3.5 API Enhancements

#### Enhanced Definition Endpoint

```typescript
// packages/app/src/runtime/server/api/_workflows/definition.get.ts

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const runId = query.run_id as string
  
  if (!runId) {
    throw createError({ statusCode: 400, statusMessage: 'Missing run_id' })
  }

  const iii = useIii()

  // Fetch definition (includes metadata now)
  const def = await iii.trigger({ 
    function_id: 'state::get', 
    payload: { scope: 'workflow_def', key: runId } 
  }).catch(() => null)

  return def
})
```

#### New Node Metadata Endpoint

```typescript
// packages/app/src/runtime/server/api/_workflows/node-metadata.get.ts

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const runId = query.run_id as string
  const nodeUid = query.node_uid as string
  
  if (!runId || !nodeUid) {
    throw createError({ 
      statusCode: 400, 
      statusMessage: 'Missing run_id or node_uid' 
    })
  }

  const iii = useIii()

  // Fetch node execution metadata
  const metadata = await iii.trigger({ 
    function_id: 'state::get', 
    payload: { 
      scope: 'workflow_node_metadata', 
      key: `${runId}/${nodeUid}` 
    } 
  }).catch(() => null)

  return metadata
})
```

---

## 4. UI Integration

### 4.1 Enhanced Workflow Detail View

```vue
<script setup lang="ts">
const { data: definition } = await useFetch('/api/_workflows/definition', {
  query: { run_id: props.runId }
})

const { data: status } = await useFetch('/api/_workflows/status', {
  query: { run_id: props.runId }
})
</script>

<template>
  <div class="workflow-detail">
    <!-- Workflow Metadata -->
    <div class="metadata-card">
      <h3>{{ definition.metadata?.name || 'Unnamed Workflow' }}</h3>
      <p>{{ definition.metadata?.description }}</p>
      <div class="tags">
        <span v-for="tag in definition.metadata?.tags" :key="tag">
          {{ tag }}
        </span>
      </div>
    </div>
    
    <!-- Execution Timeline -->
    <div class="timeline">
      <div v-for="(node, uid) in status.nodes" :key="uid">
        <div class="node-execution">
          <span class="runtime-badge" :class="node.function?.runtime">
            {{ node.function?.runtime || 'unknown' }}
          </span>
          <span class="worker-name">{{ node.worker_name }}</span>
          <span class="duration">
            {{ formatDuration(node.completed_at - node.pending_at) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
```

---

## 5. Implementation Phases

### Phase 1: State Schema Updates ✅ Next
1. Update Rust types (`WorkflowDef`, `NodeCheckpoint`)
2. Add migration logic (backward compatible)
3. Test serialization/deserialization

### Phase 2: Runtime Injection
1. Node.js wrapper enhancement
2. Python wrapper enhancement
3. Rust orchestrator updates

### Phase 3: API Layer
1. New metadata endpoints
2. Enhanced existing endpoints
3. Type generation for frontend

### Phase 4: UI Integration
1. Metadata display components
2. Timeline visualization
3. Runtime badges

### Phase 5: Telemetry (Optional)
1. OpenTelemetry span creation
2. Duration metrics
3. Performance dashboard

---

## 6. Backward Compatibility

### 6.1 Optional Fields

All new fields use `Option<T>` and `#[serde(default, skip_serializing_if = "Option::is_none")]`:
- Existing workflows continue to work
- New workflows populate metadata automatically
- No migration required

### 6.2 Runtime Detection

If function runtime is not specified, default to `Unknown`:
```rust
pub fn detect_runtime(function_id: &str) -> FunctionRuntime {
    // Heuristics based on function ID patterns
    if function_id.contains("::") {
        FunctionRuntime::NodeJS
    } else if function_id.ends_with(".py") {
        FunctionRuntime::Python
    } else {
        FunctionRuntime::Unknown
    }
}
```

---

## 7. Testing Strategy

### 7.1 Unit Tests

```rust
#[test]
fn enhanced_workflow_def_serialization() {
    let def = WorkflowDef {
        version: 1,
        nodes: BTreeMap::new(),
        output: OutputRef { from: "node:test".into() },
        metadata: Some(WorkflowMetadata {
            created_by_worker: Some("test-worker".into()),
            name: Some("Test Workflow".into()),
            description: None,
            tags: vec!["test".into()],
        }),
    };
    
    let json = serde_json::to_string(&def).unwrap();
    let parsed: WorkflowDef = serde_json::from_str(&json).unwrap();
    
    assert_eq!(parsed.metadata.unwrap().name, Some("Test Workflow".into()));
}
```

### 7.2 Integration Tests

1. Start workflow with metadata
2. Execute nodes via different runtimes
3. Fetch node metadata
4. Verify timestamps are correct
5. Check telemetry emissions

---

## 8. Future Enhancements

### 8.1 Advanced Metrics
- Function call counts per runtime
- Error rates by worker
- Retry patterns analysis

### 8.2 UI Features
- Worker health dashboard
- Runtime performance comparison
- Execution timeline scrubber

### 8.3 Observability
- Distributed tracing integration
- Custom metric exporters
- Alert rules on execution patterns

---

## References

- [iii Workflow Worker](../../workflow-worker/)
- [OpenTelemetry Best Practices](https://opentelemetry.io/docs/)
- [Workflow V1 Roadmap](./workflow-v1-roadmap.md)
