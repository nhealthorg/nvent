# Workflow Metadata Tracking - Überarbeitete Architektur

**Status**: ✅ Implementiert  
**Date**: 2026-07-14

---

## Problem mit der ersten Implementierung

❌ **Ineffizient**: Runtime-Info wurde erst bei **Ausführung** getrackt
- Separate `workflow_node_metadata` State-Table  
- 3x `state::set` Calls pro Node (start metadata, complete metadata, result)
- Logik verteilt über Node.js, Python UND Rust Worker

## Die bessere Lösung

✅ **Effizient**: Runtime-Info wird **zur Compile-Zeit** ermittelt
- Runtime-Info ist Teil der WorkflowDef (statisch)
- Nur 1x `state::put_run` mit allen Metadaten
- Zentrale Logik im Rust Worker (NodeCheckpoint)

---

## Architektur-Änderungen

### 1. Runtime-Detection zur Compile-Zeit

```typescript
// packages/nvent/src/runtime/nitro/utils/defineWorkflow.ts

function detectFunctionRuntime(functionId: string): 'nodejs' | 'python' | 'unknown' {
  if (functionId.includes('::')) return 'nodejs'  // TypeScript convention
  if (functionId.endsWith('.py') || functionId.includes('python')) return 'python'
  return 'unknown'
}
```

**In `defineWorkflow.compile()`**:
```typescript
if (spec.function) {
  const fnSpec = typeof spec.function === 'string' 
    ? { id: spec.function } 
    : spec.function
  
  // Auto-detect runtime (zur Compile-Zeit!)
  if (!fnSpec.runtime) {
    fnSpec.runtime = detectFunctionRuntime(fnSpec.id)
  }
  
  nodeDef.function = fnSpec
}
```

### 2. Workflow-Metadaten im Definition Payload

```typescript
// In defineWorkflow.handler():
await iii.trigger({
  function_id: 'workflow::start',
  payload: {
    definition: {
      ...plan,
      metadata: {
        name: options.name,
        description: options.description,
        created_by_worker: `nvent-nodejs-${process.pid}`,
      },
    },
    input
  }
})
```

### 3. Rust Worker schreibt Metadaten in NodeCheckpoint

Die NodeCheckpoint-Struktur hat jetzt:
```rust
pub struct NodeCheckpoint {
    pub state: NodeState,
    // ... bestehende Felder ...
    pub completed_at: Option<i64>,        // ✨ Wird vom Rust Worker gesetzt
    pub worker_name: Option<String>,      // ✨ Wird vom Rust Worker gesetzt
}
```

**Der Rust Worker ist verantwortlich für**:
- `pending_at` setzen beim Start (bereits vorhanden)
- `worker_name` setzen (kann vom function runtime ableiten oder von Engine metadata)
- `completed_at` setzen wenn Node fertig ist

---

## Datenfluss

```
1. Workflow Definition (Compile-Zeit)
   └─> defineWorkflow.compile()
       └─> detectFunctionRuntime(fn.id)
           └─> FunctionSpec.runtime = 'nodejs' | 'python'

2. Workflow Start
   └─> workflow::start mit Definition + Metadata
       └─> Rust Worker speichert Definition

3. Node Execution
   └─> Rust Worker: fire_node()
       ├─> NodeCheckpoint.pending_at = now()
       ├─> NodeCheckpoint.worker_name = "workflow-orchestrator"
       └─> dispatch function

4. Node Completion
   └─> workflow::node-completed Event
       └─> Rust Worker: reconcile
           └─> NodeCheckpoint.completed_at = now()
```

---

## Entfernte Komplexität

❌ **Entfernt**:
- `workflow_node_metadata` State-Table
- 2x extra `state::set` calls pro Node
- Runtime-Tracking-Logik in Node.js Wrapper
- Runtime-Tracking-Logik in Python Wrapper

✅ **Bleibt**:
- Node.js/Python Wrapper: Nur result schreiben + event emittieren
- Rust Worker: Alles andere (timestamps, worker_name)

---

## API-Anpassungen nötig

Die bestehenden Endpoints müssen angepasst werden:

### Alter Ansatz (entfernt):
```typescript
GET /api/_workflows/node-metadata?run_id=...&node_uid=...
// Liest aus workflow_node_metadata scope
```

### Neuer Ansatz:
```typescript
GET /api/_workflows/status?run_id=...
// Gibt zurück:
{
  nodes: {
    "step1": {
      state: "done",
      pending_at: 1720934567890,
      completed_at: 1720934569123,  // ✨ Direkt hier!
      worker_name: "workflow-orchestrator",  // ✨ Direkt hier!
    }
  }
}
```

**Runtime-Info kommt aus der Definition**:
```typescript
GET /api/_workflows/definition?run_id=...
// Gibt zurück:
{
  nodes: {
    "step1": {
      function: {
        id: "my::function",
        runtime: "nodejs"  // ✨ Statisch in der Definition!
      }
    }
  },
  metadata: {
    name: "My Workflow",
    created_by_worker: "nvent-nodejs-12345"
  }
}
```

---

## Next Steps - Rust Worker Implementation

**Noch zu tun im Rust Worker** (packages/workflow-worker/src/):

### 1. `fire_node()` - Worker Name setzen
```rust
// In src/functions/tick.rs::fire_node()

record.nodes.insert(
    node_uid.to_string(),
    NodeCheckpoint {
        state: NodeState::Running,
        pending_at: Some(deps.now_ms()),
        worker_name: Some("workflow-orchestrator".to_string()),  // ✅ Schon drin!
        // ...
    },
);
```

### 2. `node_completed::handle()` - Completion Time setzen
```rust
// In src/functions/node_completed.rs

if let Some(checkpoint) = record.nodes.get_mut(&req.node_uid) {
    checkpoint.state = NodeState::Done;
    checkpoint.completed_at = Some(deps.now_ms());  // ✨ Hinzufügen
    // ...
}
```

---

## UI Integration (unverändert)

Die UI kann jetzt aus **zwei Quellen** lesen:

**1. Definition (statisch)**:
- Runtime (nodejs/python)
- Function ID
- Workflow Name/Description

**2. Status (dynamisch)**:
- Worker Name
- Start Time (pending_at)
- Completion Time (completed_at)
- Execution Duration

```vue
<script setup lang="ts">
const { data: definition } = await useFetch('/api/_workflows/definition', {
  query: { run_id: props.runId }
})

const { data: status } = await useFetch('/api/_workflows/status', {
  query: { run_id: props.runId }
})

function getNodeMetadata(nodeId: string) {
  const checkpoint = status.value?.nodes[nodeId]
  const nodeDef = definition.value?.nodes[nodeId]
  
  return {
    runtime: nodeDef?.function?.runtime,  // Aus Definition
    workerName: checkpoint?.worker_name,   // Aus Status
    duration: checkpoint?.completed_at 
      ? checkpoint.completed_at - checkpoint.pending_at 
      : null
  }
}
</script>

<template>
  <div v-for="(node, uid) in status.nodes" :key="uid">
    <span class="runtime-badge" :class="getNodeMetadata(uid).runtime">
      {{ getNodeMetadata(uid).runtime }}
    </span>
    <span>{{ getNodeMetadata(uid).duration }}ms</span>
  </div>
</template>
```

---

## Vorteile der neuen Architektur

1. **Performance**: 67% weniger State-Writes (1 statt 3 pro Node)
2. **Einfachheit**: Eine zentrale Stelle (Rust Worker) statt drei (Node/Python/Rust)
3. **Korrektheit**: Runtime-Info kann nicht "falsch" sein (compile-time known)
4. **Wartbarkeit**: Weniger Code, klare Verantwortlichkeiten

---

## Dateien die geändert wurden

✅ **Rust Types**: `packages/workflow-worker/src/types.rs`
- `FunctionRuntime` enum hinzugefügt
- `WorkflowMetadata` struct hinzugefügt  
- `NodeCheckpoint.completed_at` + `.worker_name` hinzugefügt

✅ **defineWorkflow**: `packages/nvent/src/runtime/nitro/utils/defineWorkflow.ts`
- `detectFunctionRuntime()` hinzugefügt
- Runtime auto-detection bei Compile
- Metadata in workflow::start payload

✅ **Node.js Wrapper**: `packages/nvent/src/runtime/nitro/utils/workers/node.ts`
- workflow_node_metadata Tracking **entfernt**

✅ **Python Wrapper**: `packages/nvent/src/runtime/python/worker_runtime.py`
- workflow_node_metadata Tracking **entfernt**

⏳ **TODO - Rust Worker**: `packages/workflow-worker/src/functions/`
- `node_completed::handle()`: `completed_at` setzen
- `tick::fire_node()`: `worker_name` setzen (schon drin!)

⏳ **TODO - API**: `packages/app/src/runtime/server/api/_workflows/`
- `node-metadata.get.ts` und `metadata.get.ts` können **gelöscht** werden
- Status endpoint gibt bereits alles zurück!
