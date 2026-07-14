# nvent Workflow V1 Implementation Roadmap

**Status**: 🏗️ In Progress  
**Target Version**: v1.1.0  
**Current Phase**: Phase 2 - Developer Experience

---

## Phase 1: Infrastructure & Discovery ✅ COMPLETE

### Completed Tasks
- [x] **Specification** - Created comprehensive workflow specs based on official iii workflow worker
- [x] **Workflow Worker Integration** - Added workflow worker to nvent engine startup
  - Implemented `WorkflowWorkerManager` in `packages/nvent/src/runtime/nitro/utils/workers/workflow.ts`
  - Integrated into `packages/nvent/src/module.ts` with automatic startup via iii-exec
  - Rust binary managed by iii engine (no separate Docker container in dev)
- [x] **DAG Orchestration** - Using official iii workflow worker from `packages/workflow-worker`
  - Supports `workflow::start`, `workflow::status`, `workflow::tick`
  - Function-first execution (extended from agent-based model)
  - Run sharding and idempotency built-in

## Phase 2: Developer Experience (Iteration 2) 🚧 IN PROGRESS

- [x] **`defineWorkflow` Core Functionality**
  - Implemented `defineWorkflow` in `packages/nvent/src/runtime/nitro/utils/defineWorkflow.ts`
  - Compiler transforms procedural `ctx.node()` API into static DAG JSON
  - Input normalization (string/array/object → InputSpec format)
  - Function and agent executor support
- [x] **Auto-discovery**
  - Added `server/workflows/*.ts` scanning in registry
  - Workflows registered alongside functions
  - Separate workflow directory from functions
- [x] **Example Workflows**
  - `simple-text.ts` - Single node workflow
  - `pipeline::dag.ts` - Python function integration
  - `multi-step.ts` - Sequential node execution with dependencies
- [ ] **Type Safety** (Next up)
  - Generate TypeScript types for workflow inputs and outputs
  - Ensure `ctx.node()` is type-safe regarding function IDs and payloads
  - Add workflow result type inference

### Current Working State
✅ Workflows compile to correct DAG format  
✅ Functions called via `{ function: { id: "..." } }` executor  
✅ Input specifications properly normalized  
✅ Auto-discovery and registration working  
✅ Documentation and examples created  

### Next Steps
1. Test the workflows via iii console
2. Verify function execution works end-to-end
3. Add type safety and IntelliSense support
4. Create test suite for workflow compilation

## Phase 3: UI & Management (Iteration 3)
- [ ] **Workflow Console**
  - Add a "Workflows" tab to the `nvent` console.
  - Visualize the DAG using VueFlow.
  - Live tracking of workflow execution status.
  - Manual triggers and history.

## Phase 4: Advanced Control Flow (Iteration 4)
- [ ] **Dynamic Runtime Features**
  - Implement `if/else` branching in the Rust orchestrator.
  - Implement `loops` (forEach, while) in the Rust orchestrator.
  - Implement error handling (`try/catch` steps).
  - Surface these in the UI.

---

## Technical Details: Iteration 1

### 1. Rust Worker Orchestration
The Rust worker (`packages/workflow-worker`) will be managed by a new orchestrator in the Nuxt module.
In dev mode, it will run `cargo run` or start the pre-compiled binary.

### 2. DAG Orchestration Core
The worker will receive a DAG definition:
```json
{
  "nodes": [
    { "id": "step1", "function_id": "math::add", "payload": { "a": 1, "b": 2 } },
    { "id": "step2", "function_id": "math::multiply", "payload": { "a": 10 }, "depends_on": ["step1"] }
  ]
}
```
It will use `iii-state` to persist progress and `iii-queue` to dispatch steps.
