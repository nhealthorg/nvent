# nvent Workflows

Workflows are defined in `/server/workflows/*.ts` and automatically discovered by nvent.

## File Structure and Function IDs

Workflows follow the same namespace rules as functions:
- `server/workflows/simple.ts` → ID: `simple`
- `server/workflows/pipeline/dag.ts` → ID: `pipeline::dag`
- `server/workflows/a/b/c.ts` → ID: `a::b::c`

**Important:** The workflow ID is derived from the file path, NOT from the `name` field in `defineWorkflow()`.

## Basic Example

```typescript
// server/workflows/example.ts
import { defineWorkflow } from '#nvent/server'

export default defineWorkflow({
  name: 'my-workflow',
  description: 'Example workflow',
  handler: async (ctx, input: { text: string }) => {
    // Call a function - input comes from workflow input
    const result = await ctx.node('analyze', {
      function: 'analyze',
      input: 'run_input'
    })
    
    return result
  }
})
```

## Triggering a Workflow

Via TypeScript:
```typescript
const iii = useIii()
const result = await iii.trigger({
  function_id: 'my-workflow',
  payload: { text: 'Hello world' }
})
```

Via iii Console:
```
workflow::start
{
  "definition": { ... compiled from defineWorkflow ... },
  "input": { "text": "Hello world" }
}
```

## Node Input Specifications

### Use workflow input
```typescript
ctx.node('step1', {
  function: 'some-function',
  input: 'run_input'  // Passes the entire workflow input
})
```

### Use output from another node
```typescript
const step1 = await ctx.node('step1', {
  function: 'fetch-data',
  input: 'run_input'
})

const step2 = await ctx.node('step2', {
  function: 'process-data',
  input: step1  // Uses output from step1 (translated to 'node:step1')
})
```

### Join multiple nodes
```typescript
const a = await ctx.node('a', { function: 'fn-a', input: 'run_input' })
const b = await ctx.node('b', { function: 'fn-b', input: 'run_input' })

const join = await ctx.node('join', {
  function: 'merge-results',
  input: [a, b]  // Receives { a: <result>, b: <result> }
})
```

## Current Limitations

- No inline data transformation (use dedicated functions for transforms)
- No conditional branching yet (if/else)
- Input must match the exact shape expected by the called function

## E2E Workflow For New Features

Use `server/workflows/e2e-new-features.ts` (ID: `e2e-new-features`) to validate the latest workflow features end-to-end:

- Partial payload refs in `ctx.call(...)` (including nested refs)
- Workflow variables via `ctx.var(...)`
- Passing var payload into later calls
- Loop item field refs (`loop.item.id`, `loop.item.text`) in loop calls

Trigger example:

```typescript
const iii = useIii()
const res = await iii.trigger({
  function_id: 'e2e-new-features',
  payload: { seed: 'hello-e2e' }
})
```

Expected final result shape:

```json
{
  "success": true,
  "summary": {
    "partialOk": true,
    "varAccepted": true,
    "loopCount": 3
  },
  "details": { "...": "full intermediate outputs" }
}
```

## Workflow DAG Compilation

When you define a workflow, `defineWorkflow` compiles it into a static DAG that looks like:

```json
{
  "nodes": {
    "analyze": {
      "function": { "id": "analyze" },
      "input": { "from": "run_input" },
      "depends_on": []
    }
  },
  "output": { "from": "analyze" }
}
```

This DAG is sent to the workflow-worker (Rust) which orchestrates the execution.
