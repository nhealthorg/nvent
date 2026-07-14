# nvent Workflows - iii-basierte Workflow-Orchestrierung

**Status**: 🎯 Spezifikation  
**Version**: v1.0  
**Datum**: 2026-07-10  
**Inspiration**: Vercel Workflows, iii Engine  

---

## 1. Überblick

nvent Workflows ist eine Abstraktion über die iii Engine, die es ermöglicht, deklarative, programmierbare Workflows zu schreiben. Im Gegensatz zur bisherigen BullMQ-basierten Implementation nutzt diese Version die nativen iii-Primitives (Functions, Triggers, State, Queues, Streams) und wrappet sie in eine entwicklerfreundliche API, inspiriert von Vercel Workflows.

### 1.1 Design-Prinzipien

1. **Developer-First API**: Einfache, intuitive API ähnlich Vercel Workflows
2. **iii-Native**: Vollständige Nutzung von iii Workers, Functions, Triggers
3. **Type-Safe**: TypeScript-first mit vollständiger Auto-Completion
4. **Visualisierbar**: Dry-Run Modus für UI-Graph-Generierung
5. **Skalierbar**: Parallele Execution über iii-queue
6. **Observable**: Vollständige Integration mit iii-observability

### 1.2 Kernkonzepte

```typescript
// Workflow = Event-driven State Machine (nicht blockierend!)
defineWorkflow({ name, handler, config })

// Step = Isolated, retry-able unit of work (iii Function)
ctx.step('name', handler)

// Context = Runtime context für State, Streams, Triggers
ctx.state, ctx.stream, ctx.trigger

// Loop = Parallele Execution mit automatischer Queue-Verteilung
ctx.forEach(items, handler)

// Event-Driven: Workflow blockiert NICHT, Orchestrator reagiert auf Events
```

---

## 2. Architektur-Übersicht

### 2.1 Komponenten-Stack

```
┌─────────────────────────────────────────────────────────────┐
│                    Developer Experience                      │
│  /server/workflows/*.ts  +  /server/functions/*.ts          │
│     defineWorkflow()          defineFunction()              │
└────────────────┬────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────────┐
│                nvent Workflow Runtime                        │
│  - Workflow Compiler (AST → Graph)                          │
│  - Dry-Run Engine (Static Analysis)                         │
│  - Execution Engine (iii Integration)                       │
│  - Context Provider (State, Stream, Trigger)                │
└────────────────┬────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────────┐
│                    iii Engine Layer                          │
│  - iii-state   (Workflow State Management)                  │
│  - iii-queue   (Parallel Step Execution)                    │
│  - iii-stream  (Real-time Updates)                          │
│  - iii-pubsub  (Event Distribution)                         │
│  - Functions   (Step Implementations)                       │
│  - Triggers    (Workflow Entry Points)                      │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Dateistruktur

```
/server
├── /workflows              # Workflow-Definitionen (neu)
│   ├── ai-content.ts
│   ├── approval.ts
│   └── data-pipeline.ts
│
├── /functions              # Function-Definitionen (bestehend)
│   ├── generate-draft.ts
│   ├── summarize.ts
│   └── send-email.ts
│
└── /triggers               # Trigger-Definitionen (optional)
    ├── scheduled.ts
    └── webhooks.ts
```

---

## 3. API-Design

### 3.1 Workflow Definition

```typescript
// server/workflows/ai-content.ts
import { defineWorkflow } from '#nvent/workflows'
import { generateDraft, summarize, publish } from '#functions'

export default defineWorkflow({
  name: 'ai-content',
  description: 'AI-gestützte Content-Erstellung mit Approval',
  timeout: '8 days',
  
  // Optional: Trigger definitions
  triggers: [
    { type: 'http', config: { method: 'POST', path: '/api/workflows/ai-content' } },
    { type: 'cron', config: { expression: '0 9 * * 1' } }
  ],
  
  // Workflow Handler (wird als State Machine kompiliert!)
  handler: async (input: { topic: string }, ctx) => {
    // Step 1: Generate draft (calls iii function)
    const draft = await ctx.step('generate-draft', async () => {
      return await generateDraft({ topic: input.topic })
    })
    
    // Step 2: Summarize (parallel possible)
    const [summary, tags] = await Promise.all([
      ctx.step('summarize', async () => {
        return await summarize({ text: draft.content })
      }),
      ctx.step('extract-tags', async () => {
        return await extractTags({ text: draft.content })
      })
    ])
    
    // Step 3: Store in state
    await ctx.state.set('draft-data', {
      draft,
      summary,
      tags,
      status: 'pending-approval'
    })
    
    // Step 4: Wait for approval (hook pattern - NICHT blockierend!)
    const approval = await ctx.waitFor('approval-received', {
      timeout: '7 days'
    })
    
    if (approval.approved) {
      // Step 5: Publish
      await ctx.step('publish', async () => {
        return await publish({ 
          content: draft.content,
          summary: summary.text,
          tags: tags.list
        })
      })
    }
    
    // Stream final result to client
    await ctx.stream.send('workflow-completed', {
      status: approval.approved ? 'published' : 'rejected'
    })
    
    return {
      success: true,
      published: approval.approved
    }
  }
})
```

### 3.2 Step Definition (iii Function Wrapper)

```typescript
// server/functions/generate-draft.ts
import { defineFunction } from '#nvent/functions'

export const generateDraft = defineFunction({
  id: 'ai::generate-draft',
  schema: {
    input: z.object({
      topic: z.string()
    }),
    output: z.object({
      content: z.string(),
      wordCount: z.number()
    })
  },
  handler: async (input) => {
    // Actual implementation
    const content = await callOpenAI(input.topic)
    
    return {
      content,
      wordCount: content.split(' ').length
    }
  },
  retry: {
    maxAttempts: 3,
    backoff: 'exponential'
  }
})
```

### 3.3 Loop Execution mit Queue-Parallelisierung
```typescript
import { defineWorkflow } from '#nvent/workflows'
import { fetchUser, enrichUserData } from '#nvent/functions'

export default defineWorkflow({
  name: 'data-pipeline',
  handler: async (input: { userIds: string[] }, ctx) => {
    // Parallel processing über iii-queue
    'use workflow'
  
  // Parallel processing über iii-queue
  const results = await ctx.forEach(
    input.userIds,
    async (userId, index) => {
      // Jeder Loop-Durchlauf wird als Queue-Job ausgeführt
      const userData = await ctx.step(`fetch-user-${userId}`, async () => {
        return await fetchUser({ id: userId })
      })
      
      const enriched = await ctx.step(`enrich-user-${userId}`, async () => {
        return await enrichUserData({ data: userData })
      })
      
      return enriched
    },
    {
      concurrency: 10,     // Max 10 parallel
      queue: 'user-processing',
      timeout: '5m'
    }
  )
  
    // Warte auf alle Loop-Durchläufe
    await ctx.state.set('processed-users', results)
    
    return { processedCount: results.length }
  }
})
```

### 3.4 Nested Workflows

```typescript
// server/workflows/parent.ts
import { defineWorkflow } from '#nvent/workflows'

export default defineWorkflow({
  name: 'parent-workflow',
  handler: async (input, ctx) => {
    // Loop mit verschachteltem Workflow
    await ctx.forEach(input.items, async (item) => {
      // Rufe Child-Workflow für jeden Item auf
      const result = await ctx.runWorkflow('child-workflow', {
        data: item
      })
      
      return result
    })
  }
})

// server/workflows/child.ts
import { defineWorkflow } from '#nvent/workflows'
import { processData, validateData } from '#nvent/functions'

export default defineWorkflow({
  name: 'child-workflow',
  handler: async (input, ctx) => {
    // Mehrere sequentielle Steps
    const step1 = await ctx.step('step-1', async () => {
      return await processData(input.data)
    })
    
    const step2 = await ctx.step('step-2', async () => {
      return await validateData(step1)
    })
    
    return step2
  }
  return step2
})
```

---

## 4. Workflow Context API

### 4.1 Context Interface

```typescript
interface WorkflowContext {
  // Workflow Metadata
  workflowId: string
  runId: string
  parentRunId?: string
  
  // Step Execution
  step<T>(
    name: string,
    handler: () => Promise<T>,
    options?: StepOptions
  ): Promise<T>
  
  // Loop Execution
  forEach<T, R>(
    items: T[],
    handler: (item: T, index: number) => Promise<R>,
    options?: ForEachOptions
  ): Promise<R[]>
  
  // Nested Workflows
  runWorkflow<T, R>(
    workflowName: string,
    input: T,
    options?: WorkflowOptions
  ): Promise<R>
  
  // State Management (iii-state)
  state: {
    get<T>(key: string): Promise<T | null>
    set<T>(key: string, value: T): Promise<void>
    delete(key: string): Promise<void>
    scope(name: string): StateScope
  }
  
  // Real-time Streaming (iii-stream)
  stream: {
    send(event: string, data: any): Promise<void>
    subscribe(event: string, handler: (data: any) => void): void
  }
  
  // Event Waiting (Hooks)
  waitFor<T>(
    event: string,
    options?: WaitForOptions
  ): Promise<T>
  
  // Triggers
  trigger(
    functionId: string,
    payload: any,
    options?: TriggerOptions
  ): Promise<any>
  
  // Delays
  sleep(duration: string | number): Promise<void>
  
  // Logging
  logger: {
    info(message: string, meta?: any): void
    warn(message: string, meta?: any): void
    error(message: string, meta?: any): void
  }
}
```

### 4.2 Step Options

```typescript
interface StepOptions {
  // iii-queue routing
  queue?: string
  
  // Retry configuration
  retry?: {
    maxAttempts?: number
    backoff?: 'linear' | 'exponential'
    initialDelay?: number
  }
  
  // Timeout
  timeout?: string | number
  
  // Conditional execution
  condition?: () => boolean | Promise<boolean>
}
```

### 4.3 ForEach Options

```typescript
interface ForEachOptions {
  // Concurrency control
  concurrency?: number
  
  // Queue routing
  queue?: string
  
  // Batch processing
  batchSize?: number
  
  // Error handling
  continueOnError?: boolean
  
  // Timeout per item
  timeout?: string | number
  
  // Progress tracking
  onProgress?: (completed: number, total: number) => void
}
```

---

## 5. iii Integration

### 5.0 Event-Driven Orchestration (NICHT blockierend!)

**Wichtig**: Der Workflow-Handler läuft NICHT als lange blockierende Function. Stattdessen:

#### 5.0.1 Workflow als State Machine

```typescript
// Der Workflow-Code wird zur Build-Zeit in eine State Machine kompiliert
{
  states: [
    { id: 'generate-draft', type: 'step', next: ['summarize', 'extract-tags'] },
    { id: 'summarize', type: 'step', next: ['wait-approval'] },
    { id: 'extract-tags', type: 'step', next: ['wait-approval'] },
    { id: 'wait-approval', type: 'wait', next: ['publish'], condition: 'approved' },
    { id: 'publish', type: 'step', next: ['end'] }
  ]
}
```

#### 5.0.2 Workflow Orchestrator (iii Worker)

Der Orchestrator ist ein dedizierter iii Worker:

```typescript
// packages/nvent/src/runtime/workflow-orchestrator.ts
export class WorkflowOrchestrator {
  constructor(private worker: IIIWorker) {
    // Subscribe zu Step-Completion Events
    worker.registerTrigger({
      type: 'subscribe',
      function_id: 'workflow::orchestrator::on-step-completed',
      config: { topic: 'workflow:step:completed' }
    })
    
    // Subscribe zu waitFor Events
    worker.registerTrigger({
      type: 'subscribe',
      function_id: 'workflow::orchestrator::on-event-received',
      config: { topic: 'workflow:event:*' }
    })
  }
  
  async onStepCompleted(event: StepCompletedEvent) {
    const { runId, stepId, result } = event
    
    // 1. Load workflow state
    const state = await this.getWorkflowState(runId)
    
    // 2. Update state mit step result
    state.stepResults[stepId] = result
    state.completedSteps.push(stepId)
    
    // 3. Determine next steps (aus State Machine)
    const nextSteps = this.getNextSteps(state)
    
    // 4. Enqueue next steps
    for (const step of nextSteps) {
      await this.executeStep(runId, step, state)
    }
    
    // 5. Check if workflow complete
    if (this.isWorkflowComplete(state)) {
      await this.completeWorkflow(runId, state)
    }
  }
  
  async executeStep(runId: string, stepId: string, state: WorkflowState) {
    // Step wird als Queue Job ausgeführt
    await worker.trigger({
      function_id: `workflow::${state.workflowName}::step::${stepId}`,
      payload: {
        runId,
        stepId,
        context: this.buildStepContext(state)
      },
      action: TriggerAction.Enqueue({ queue: 'workflow-steps' })
    })
  }
}
```

#### 5.0.3 Execution Flow (Event-Driven)

```
1. Workflow Start
   → Orchestrator erstellt initial State
   → Enqueued erste Steps
   
2. Step Execution
   → iii-queue führt Step aus
   → Step completed → Event published
   
3. Orchestrator reagiert auf Event
   → Liest State
   → Bestimmt nächste Steps aus State Machine
   → Enqueued nächste Steps
   
4. ctx.waitFor()
   → Orchestrator setzt State auf 'waiting'
   → Subscribes zu Event Topic
   → KEINE blockierende Wait!
   
5. Event arrives
   → Orchestrator wacht auf
   → Fortsetzt Execution
   
6. Workflow Complete
   → Orchestrator markiert als 'completed'
   → Emitted final events
```

#### 5.0.4 Keine Node.js Blockierung!

```typescript
// ❌ FALSCH: Blockierende Ausführung
async function badWorkflow(input, ctx) {
  const result = await longRunningStep() // Blockiert Node.js!
  await ctx.waitFor('approval') // Blockiert Node.js für Tage!
}

// ✅ RICHTIG: Event-Driven Ausführung
async function goodWorkflow(input, ctx) {
  // ctx.step() gibt sofort zurück
  // Actual execution passiert async über Queue
  const resultPromise = ctx.step('long-running', longRunningStep)
  
  // Compiler wandelt das in State Machine um
  // Orchestrator wartet auf Event, nicht die Function
  const approval = await ctx.waitFor('approval')
}
```

#### 5.0.5 Dedizierter Workflow Worker

```typescript
// packages/nvent/src/runtime/workflow-worker.ts
export async function startWorkflowWorker(config: WorkflowConfig) {
  const worker = registerWorker(config.iiiUrl, {
    workerName: 'nvent-workflow-orchestrator'
  })
  
  // Register orchestrator functions
  const orchestrator = new WorkflowOrchestrator(worker)
  
  // Register all workflow functions
  for (const workflow of config.workflows) {
    worker.registerFunction(
      `workflow::${workflow.name}`,
      async (payload) => {
        // Startet nur den Workflow, läuft nicht komplett durch
        return await orchestrator.startWorkflow(workflow.name, payload)
      }
    )
    
    // Register each step als separate Function
    for (const step of workflow.steps) {
      worker.registerFunction(
        `workflow::${workflow.name}::step::${step.id}`,
        step.handler
      )
    }
  }
  
  return worker
}
```

#### 5.0.6 Integration mit Nuxt

```typescript
// packages/nvent/src/module.ts
export default defineNuxtModule({
  async setup(options, nuxt) {
    // Option 1: Embedded Worker (für Development)
    if (nuxt.options.dev) {
      nuxt.hook('ready', async () => {
        const worker = await startWorkflowWorker({
          iiiUrl: options.iiiUrl,
          workflows: await scanWorkflows()
        })
      })
    }
    
    // Option 2: Separate Worker Process (für Production)
    // User startet manuell: `nvent-workflow-worker`
  }
})
```

#### 5.0.7 Orchestrator Skalierung & Concurrency Control

**Problem**: Mehrere Orchestrator-Instanzen könnten auf dasselbe Event reagieren und duplicate steps ausführen.

**Wichtige Constraints (aus offiziellem iii workflow worker):**

```
❌ NICHT VERFÜGBAR in iii-state (SDK 0.20.0):
- state::cas (compare-and-swap)
- if_match / version checking
- Optimistic locking
- state::set ist unconditional overwrite!
```

**✅ LÖSUNG: Run Sharding (Official Pattern)**

Inspiriert vom offiziellen `iii-hq/workers/workflow`:

```typescript
// Pattern 1: Event Sharding by run_id
// "shard workflow::tick events by run_id so that all writes 
// for a given run land on one owning instance"

worker.registerTrigger({
  type: 'durable:subscriber',
  function_id: 'orchestrator::tick',
  config: { 
    topic: 'workflow:tick',
    // iii-queue verteilt Messages nach run_id
    // → Alle Events für run123 gehen zu Worker A
    // → Alle Events für run456 gehen zu Worker B
    // (Implementierung: consistent hashing auf run_id)
  }
})

// Pattern 2: In-Process Locks (nur innerhalb eines Workers)
export class WorkflowOrchestrator {
  private runLocks = new Map<string, Promise<void>>()
  
  async handleTick(event: WorkflowTickEvent) {
    const { run_id } = event
    
    // Serialize all operations for this run within this process
    const existingLock = this.runLocks.get(run_id)
    if (existingLock) {
      await existingLock
    }
    
    const processingPromise = this.processTickLocked(run_id, event)
    this.runLocks.set(run_id, processingPromise)
    
    try {
      await processingPromise
    } finally {
      this.runLocks.delete(run_id)
    }
  }
}
```

**Idempotency Pattern (Official Pattern):**

```typescript
// Basiert auf iii-hq/workers/workflow Pattern
export class WorkflowOrchestrator {
  // In-process lock map (run sharding garantiert nur 1 worker pro run)
  private runLocks = new Map<string, Promise<void>>()
  
  async onStepCompleted(event: StepCompletedEvent) {
    const { runId, stepId, result } = event
    
    // 1. Serialize operations for this run (in-process)
    const existingLock = this.runLocks.get(runId)
    if (existingLock) {
      await existingLock
    }
    
    const processing = this.processStepCompletedLocked(runId, stepId, result, event)
    this.runLocks.set(runId, processing)
    
    try {
      await processing
    } finally {
      this.runLocks.delete(runId)
    }
  }
  
  private async processStepCompletedLocked(
    runId: string,
    stepId: string,
    result: any,
    event: StepCompletedEvent
  ) {
    // 2. Load workflow state (no version, kein CAS!)
    const state = await this.getWorkflowState(runId)
    
    // 3. Idempotency: Deterministic IDs verhindern duplicates
    // Wenn Step bereits completed, re-delivery ist no-op
    if (state.completedSteps.has(stepId)) {
      console.log(`[orchestrator] Step ${stepId} already completed, skipping`)
      return
    }
    
    // 4. Update state (unconditional overwrite ist OK,
    //    weil run sharding garantiert nur 1 writer pro run)
    state.stepResults[stepId] = result
    state.completedSteps.add(stepId)
    state.lastUpdated = Date.now()
    
    await this.saveWorkflowState(runId, state)
    
    // 5. Determine next steps from DAG
    const nextSteps = this.getNextStepsFromDAG(state)
    
    // 6. Enqueue next steps mit deterministic session IDs
    for (const step of nextSteps) {
      // Pattern: wf_<runId>_<stepId>@r<attempt>
      const sessionId = `wf_${runId}_${step.id}@r${step.attempt || 0}`
      
      await this.executeStep(runId, step, state, { sessionId })
    }
  }
  
  // Kein distributed lock nötig! Run sharding + in-process lock reicht
}
```

**Run Sharding Deployment:**

```typescript
// Deployment Strategy: Consistent Hashing auf run_id

// Option 1: Infrastructure-level Sharding (empfohlen)
// - Nutze Queue Partition Key auf run_id
// - Kubernetes StatefulSet mit shard assignment
// - Jeder Pod bekommt Shard-Range zugewiesen

// Option 2: Application-level Sharding
export class WorkflowOrchestrator {
  constructor(
    private shardId: number,
    private totalShards: number
  ) {}
  
  // Nur Events für "meine" Runs verarbeiten
  async handleTick(event: WorkflowTickEvent) {
    const { run_id } = event
    const shard = this.getShardForRun(run_id)
    
    if (shard !== this.shardId) {
      console.log(`[shard-${this.shardId}] Ignoring run ${run_id} (belongs to shard ${shard})`)
      return
    }
    
    await this.processTickForRun(run_id, event)
  }
  
  private getShardForRun(runId: string): number {
    // Consistent hashing
    const hash = cyrb53(runId)
    return hash % this.totalShards
  }
}

// Deployment:
// POD 0: WORKFLOW_SHARD_ID=0 WORKFLOW_SHARD_TOTAL=3
// POD 1: WORKFLOW_SHARD_ID=1 WORKFLOW_SHARD_TOTAL=3
// POD 2: WORKFLOW_SHARD_ID=2 WORKFLOW_SHARD_TOTAL=3
```

**Horizontale Skalierung via Run Sharding:**

```
┌─────────────────────────────────────────────────────┐
│ workflow::tick Topic (alle workflow events)         │
└────────┬─────────────────────────────────────┬──────┘
         │                                     │
         │  Events sharded by run_id           │
         │  (consistent hashing)               │
         │                                     │
    ┌────▼────┐                           ┌───▼─────┐
    │ Shard 0 │                           │ Shard 1 │
    └────┬────┘                           └───┬─────┘
         │                                    │
         ▼                                    ▼
┌─────────────────┐                  ┌─────────────────┐
│ Orchestrator    │                  │ Orchestrator    │
│ Pod 0           │                  │ Pod 1           │
│                 │                  │                 │
│ Handles:        │                  │ Handles:        │
│ - run_abc (0)   │                  │ - run_def (1)   │
│ - run_ghi (0)   │                  │ - run_jkl (1)   │
│                 │                  │                 │
│ In-process lock │                  │ In-process lock │
│ per run         │                  │ per run         │
└─────────────────┘                  └─────────────────┘

Key Features (Official Pattern):
- Run sharding: Alle Events für run_abc → immer Shard 0
- In-process locks: Serialisiert writes innerhalb eines Pods
- Kein distributed locking nötig!
- Bei Pod-Ausfall: Runs werden zu anderem Shard reassigned
- Idempotency: Deterministic session IDs (wf_<runId>_<stepId>@r<attempt>)
```

#### 5.0.8 Wiederverwendung der alten nvent Implementation

**Was wir aus der alten Implementation übernehmen:**

1. **Registry Compilation** (bereits vorhanden in `/packages/nvent/src/registry`)
   ```typescript
   // ✅ Wiederverwenden
   compileRegistryFromServerWorkers(layerInfos, functionsDir, defaultConfigs)
   ```

2. **Template Generation** (bereits vorhanden)
   ```typescript
   // ✅ Wiederverwenden und erweitern
   generateRegistryTemplate()
   generateHandlersTemplate()
   generateAnalyzedFlowsTemplate()  // Für UI Graph!
   generateTriggerRegistryTemplate()
   
   // ➕ Neu hinzufügen
   generateWorkflowsTemplate()      // Workflows Registry
   generateWorkflowTypesTemplate()  // Auto-imports für #workflows
   ```

3. **Flow Analysis Format** (für UI Visualisierung)
   ```typescript
   // ✅ Altes Format wiederverwenden
   interface AnalyzedFlow {
     name: string
     nodes: Array<{
       id: string
       type: 'step' | 'condition' | 'loop' | 'wait'
       label: string
       data?: any
     }>
     edges: Array<{
       source: string
       target: string
       label?: string
     }>
   }
   
   // Unser Compiler generiert dieses Format
   ```

4. **File Watching** (bereits vorhanden)
   ```typescript
   // ✅ Erweitern für /server/workflows
   watchQueueFiles({
     nuxt,
     layerInfos,
     queuesDir: functionsDir,  // functions
     onRefresh: refreshRegistry
   })
   
   watchWorkflowFiles({
     nuxt,
     layerInfos,
     workflowsDir: 'workflows',  // workflows
     onRefresh: refreshWorkflows
   })
   ```

5. **Nuxt Integration** (Module Structure)
   ```typescript
   // ✅ Gleiche Struktur beibehalten
   export default defineNuxtModule({
     async setup(options, nuxt) {
       // 1. Compile registry (functions + workflows)
       const registry = await compileAll(layerInfos)
       
       // 2. Generate templates
       addTemplate({ /* registry */ })
       addTemplate({ /* workflows */ })
       addTemplate({ /* analyzed-flows */ })
       
       // 3. Add server imports
       addServerImports(getServerImports())
       
       // 4. Add plugins
       addServerPlugin(/* iii worker initialization */)
       
       // 5. Watch files in dev
       if (nuxt.options.dev) {
         watchFiles({ onRefresh: refreshAll })
       }
     }
   })
   ```

#### 5.0.9 Integration mit offiziellem iii workflow worker ⭐

**ENTSCHEIDUNG**: Wir nutzen den **offiziellen iii workflow worker**!

- **Repository**: https://github.com/iii-hq/workers/tree/main/workflow
- **Features**: DAG orchestration, durable state, run sharding, idempotency
- **Status**: Production-ready, battle-tested vom iii Team
- **Vorteile**: Weniger Code, korrekte Concurrency, Updates vom iii Team

**Unsere Integrations-Strategie:**

**✅ Wir nutzen den offiziellen Worker direkt**

```typescript
// Unser defineWorkflow() generiert das offizielle workflow::start Format

export default defineWorkflow({
  name: 'sarcopenia-analysis',
  handler: async (input, ctx) => {
    const step1 = await ctx.step('fetch', async () => { /* ... */ })
    const step2 = await ctx.step('analyze', async () => { /* ... */ })
    return { result: step2 }
  }
})

// Compiler transformiert zu:
const workflowDefinition = {
  nodes: [
    {
      id: 'fetch',
      function_id: 'functions::sarcopenia::fetch',
      inputs: { /* ... */ }
    },
    {
      id: 'analyze',
      function_id: 'functions::sarcopenia::analyze',
      inputs: { /* ... */ },
      depends_on: ['fetch']
    }
  ]
}

// Start via offiziellen Worker:
await iii.trigger({
  function_id: 'workflow::start',
  payload: {
    definition: workflowDefinition,
    input: { studyId: '123' },
    notify: {
      function_id: 'nvent::workflow-completed',
      queue: 'default'
    }
  }
})
```

**Was nvent beiträgt (Developer Experience Layer):**

```typescript
// 1. Compiler: defineWorkflow() → workflow::start Format
//    User schreibt einfache ctx.step() API
//    Wir generieren offizielles DAG Format

// 2. Type-Safety: Auto-generated Types
import type { WorkflowInput, WorkflowResult } from '#workflows/sarcopenia-analysis'

// 3. UI Integration: Parse workflow::status für Visualisierung
const status = await iii.trigger({
  function_id: 'workflow::status',
  payload: { run_id }
})
// → Transformiere zu VueFlow Graph

// 4. Dev Experience: HMR für workflow changes
//    File watcher recompiliert Workflows bei Änderungen

// 5. Wrapper mit besseren Errors
export async function startWorkflow(name: string, input: any) {
  try {
    const definition = await getCompiledWorkflow(name)
    return await iii.trigger({
      function_id: 'workflow::start',
      payload: { definition, input }
    })
  } catch (err) {
    throw new WorkflowError(`Failed to start workflow ${name}`, err)
  }
}
```

**Workflow Definition Format (offizieller Standard):**

```typescript
// Das Format, das der offizielle Worker erwartet:
interface WorkflowDefinition {
  nodes: Array<{
    id: string                    // Unique node ID (z.B. 'fetch', 'analyze')
    function_id: string           // iii Function to execute (z.B. 'functions::sarcopenia::fetch')
    inputs: Record<string, any>   // Input data für die Function
    depends_on?: string[]         // Dependency node IDs (DAG edges)
  }>
}

// Unser Compiler transformiert:
// ctx.step('fetch', ...) → nodes mit auto-detected dependencies
// ctx.step('analyze', ...) mit dependency auf 'fetch'
```

**Architektur mit offiziellem Worker:**

```
┌─────────────────────────────────────────────────────────────┐
│  nvent (Developer Experience Layer)                         │
│                                                              │
│  ┌────────────────┐           ┌─────────────────────┐      │
│  │ defineWorkflow │ ──────▶   │ Workflow Compiler   │      │
│  │ (User Code)    │           │ (AST → DAG)         │      │
│  └────────────────┘           └──────────┬──────────┘      │
│                                           │                  │
│                                           ▼                  │
│                              workflow::start payload         │
└───────────────────────────────────────┬─────────────────────┘
                                        │
                                        ▼
┌───────────────────────────────────────────────────────────┐
│  iii workflow worker (Official)                           │
│  https://github.com/iii-hq/workers/tree/main/workflow     │
│                                                            │
│  - DAG Orchestration                                      │
│  - Run Sharding (run_id → shard)                         │
│  - In-process locks (WorkflowLocks)                      │
│  - Deterministic session IDs                              │
│  - workflow::tick events                                  │
│  - workflow::status / workflow::stop                      │
└───────────────────────────────────────────────────────────┘
```

**nvent nutzt den offiziellen Worker wie eine Library:**

```typescript
// packages/nvent/src/runtime/workflow-execution.ts

export class WorkflowExecutor {
  constructor(private iii: IIIClient) {}
  
  // Wrapper um workflow::start
  async startWorkflow(name: string, input: any, options?: WorkflowOptions) {
    // 1. Hole compiled workflow definition
    const definition = await this.getWorkflowDefinition(name)
    
    // 2. Validate input against schema
    if (definition.inputSchema) {
      validateInput(input, definition.inputSchema)
    }
    
    // 3. Start via offiziellen Worker
    const result = await this.iii.trigger({
      function_id: 'workflow::start',
      payload: {
        definition: definition.dag,
        input,
        notify: options?.notify || {
          function_id: `nvent::workflows::${name}::completed`
        },
        reply_to: options?.replyTo  // Für Agent-Caller
      }
    })
    
    const runId = result.run_id
    
    // 4. Setup real-time updates (optional)
    if (options?.stream) {
      await this.subscribeToWorkflowUpdates(runId, options.stream)
    }
    
    return { runId, status: 'started' }
  }
  
  // Wrapper um workflow::status
  async getWorkflowStatus(runId: string) {
    const status = await this.iii.trigger({
      function_id: 'workflow::status',
      payload: { run_id: runId }
    })
    
    return {
      runId,
      status: status.status,  // 'running' | 'completed' | 'failed'
      completedNodes: status.completed_nodes,
      result: status.result,
      error: status.result_error
    }
  }
  
  // Wrapper um workflow::stop
  async stopWorkflow(runId: string) {
    return await this.iii.trigger({
      function_id: 'workflow::stop',
      payload: { run_id: runId }
    })
  }
}
```

**Deployment: Offizieller Worker**

```yaml
# docker-compose.yml
services:
  # Offizieller iii workflow worker
  workflow-worker:
    image: ghcr.io/iii-hq/workers/workflow:latest
    environment:
      - III_URL=ws://iii-engine:49134
      - WORKER_NAME=workflow-worker-0
      - SHARD_ID=0
      - SHARD_TOTAL=3
    depends_on:
      - iii-engine
    restart: unless-stopped
```

**Kein eigener Orchestrator-Code nötig!** ✅

Der offizielle Worker kümmert sich um:
- ✅ DAG Execution
- ✅ Run Sharding
- ✅ Concurrency Control
- ✅ State Management
- ✅ Idempotency

Wir fokussieren uns auf:
- ✅ Developer Experience (defineWorkflow API)
- ✅ Compiler (ctx.step → DAG)
- ✅ Type Safety
- ✅ UI Visualisierung
- ✅ Nuxt Integration

---
```

---

**Was vereinfacht wird:**

```typescript
// ❌ ALT: Komplexes Wiring zwischen Queue Workers
export const config = defineQueueConfig({
  flow: {
    names: ['example-flow'],
    role: 'entry',
    step: 'first_step',
    emits: ['step1.complete'],
    subscribes: ['step0.complete']
  }
})

// ✅ NEU: Alles in Workflow Definition
export default defineWorkflow({
  name: 'example-flow',
  handler: async (input, ctx) => {
    // Dependencies sind implizit durch Await
    const step1 = await ctx.step('step1', ...)
    const step2 = await ctx.step('step2', ...)
    // Compiler extrahiert Dependencies automatisch!
  }
})

// Kein manuelles Wiring mehr:
// - Keine emits/subscribes Definition nötig
// - Dependencies durch Await-Chain klar
// - Compiler baut State Machine automatisch
// - Orchestrator handled Coordination
```

**Migration Path:**

```typescript
// 1. Scan old /server/queues structure
const oldFlows = await scanOldQueueStructure()

// 2. Generate migration warnings
for (const flow of oldFlows) {
  console.warn(`[nvent] Found old-style flow: ${flow.name}`)
  console.warn(`[nvent] Please migrate to /server/workflows`)
  console.warn(`[nvent] See: /docs/migration-v0-to-v1.md`)
}

// 3. Optional: Auto-generate workflow stub
if (options.generateMigrationStubs) {
  await generateWorkflowStub(flow)
}
```

---

### 5.1 Workflow → iii Function Mapping

Jeder Workflow wird als iii Function registriert:

```typescript
// Intern vom nvent Runtime generiert
worker.registerFunction(
  'workflow::ai-content',
  async (payload: { topic: string }) => {
    const ctx = createWorkflowContext(payload)
    return await aiContentWorkflow(payload, ctx)
  }
)
```

### 5.2 Step → iii Queue Job Mapping

Jeder Step wird als iii-queue Job ausgeführt:

```typescript
// Intern bei ctx.step()
await worker.trigger({
  function_id: 'step::generate-draft',
  payload: { topic: 'AI' },
  action: TriggerAction.Enqueue({
    queue: 'workflow-steps'
  })
})
```

### 5.3 State Management mit iii-state

```typescript
// Workflow-scoped state
const stateScope = `workflow:${runId}`

// ctx.state.set() intern
await worker.trigger({
  function_id: 'state::set',
  payload: {
    scope: stateScope,
    key: 'draft-data',
    value: { ... }
  }
})

// ctx.state.get() intern
const result = await worker.trigger({
  function_id: 'state::get',
  payload: {
    scope: stateScope,
    key: 'draft-data'
  }
})
```

### 5.4 Real-time Updates mit iii-stream

```typescript
// Stream channel per workflow run
const streamChannel = `workflow:${runId}:stream`

// ctx.stream.send() intern
await worker.trigger({
  function_id: 'stream::send',
  payload: {
    channel: streamChannel,
    event: 'step-completed',
    data: { stepName: 'generate-draft', result: {...} }
  }
})
```

### 5.5 Event Coordination mit iii-pubsub

```typescript
// Workflow event distribution
const topic = `workflow:${runId}:events`

// Step completion event
await worker.trigger({
  function_id: 'pubsub::publish',
  payload: {
    topic,
    data: {
      type: 'step.completed',
      stepName: 'generate-draft',
      result: {...}
    }
  }
})

// Subscribe for orchestration
worker.registerTrigger({
  type: 'subscribe',
  function_id: 'workflow::orchestrator',
  config: { topic }
})
```

---

## 6. Workflow Compiler & Dry-Run

### 6.1 Static Analysis für UI-Graph

Der Workflow-Code wird zur Build-Zeit analysiert:

```typescript
// Internal: Workflow AST Analysis
interface WorkflowGraph {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  metadata: WorkflowMetadata
}

interface WorkflowNode {
  id: string
  type: 'step' | 'condition' | 'loop' | 'workflow' | 'wait'
  label: string
  functionId?: string
  position?: { x: number, y: number }
}

interface WorkflowEdge {
  from: string
  to: string
  label?: string
  condition?: string
}
```

### 6.2 Dry-Run Execution

```typescript
// Dry-Run Mode für Graph-Generierung
const graph = await dryRunWorkflow('ai-content', {
  topic: 'Example'
})

// Output für UI
{
  nodes: [
    { id: 'start', type: 'entry', label: 'Start' },
    { id: 'generate-draft', type: 'step', label: 'Generate Draft', functionId: 'ai::generate-draft' },
    { id: 'summarize', type: 'step', label: 'Summarize' },
    { id: 'extract-tags', type: 'step', label: 'Extract Tags' },
    { id: 'wait-approval', type: 'wait', label: 'Wait for Approval' },
    { id: 'publish', type: 'step', label: 'Publish' },
    { id: 'end', type: 'exit', label: 'End' }
  ],
  edges: [
    { from: 'start', to: 'generate-draft' },
    { from: 'generate-draft', to: 'summarize' },
    { from: 'generate-draft', to: 'extract-tags' },
    { from: 'summarize', to: 'wait-approval' },
    { from: 'extract-tags', to: 'wait-approval' },
    { from: 'wait-approval', to: 'publish', condition: 'approved === true' },
    { from: 'publish', to: 'end' }
  ]
}
```

### 6.3 Compiler Implementation

```typescript
// packages/nvent/src/runtime/workflow-compiler.ts
export class WorkflowCompiler {
  compile(workflowFn: Function): WorkflowGraph {
    // 1. Parse Function als AST
    const ast = parseWorkflow(workflowFn)
    
    // 2. Extrahiere Nodes
    const nodes = extractNodes(ast)
    
    // 3. Baue Dependency Graph
    const edges = buildEdges(ast, nodes)
    
    // 4. Optimiere Layout
    const positioned = layoutGraph(nodes, edges)
    
    return { nodes: positioned, edges }
  }
  
  extractSteps(ast: AST): StepNode[] {
    // Finde alle ctx.step() Calls
  }
  
  extractLoops(ast: AST): LoopNode[] {
    // Finde alle ctx.forEach() Calls
  }
  
  extractWaits(ast: AST): WaitNode[] {
    // Finde alle ctx.waitFor() Calls
  }
}
```

### 6.4 Automatisches Wiring (Kein manuelles Wiring mehr!)

**Alte Implementation (v0.4): Manuelles Wiring**

```typescript
// ❌ Viel manuelles Wiring nötig

// Step 1: Definition
// server/queues/example/step1.ts
export default defineQueueWorker(async (job, ctx) => {
  const result = await processData(job.data)
  ctx.flow.emit('step1.complete', result)  // Manual event emission
  return result
})

export const config = defineQueueConfig({
  flow: {
    names: ['example-flow'],
    role: 'entry',              // Manual role definition
    step: 'step1',
    emits: ['step1.complete'],  // Manual event declaration
    subscribes: []              // Manual subscription
  }
})

// Step 2: Definition
// server/queues/example/step2.ts
export default defineQueueWorker(async (job, ctx) => {
  const result = await process2(job.data)
  ctx.flow.emit('step2.complete', result)
  return result
})

export const config = defineQueueConfig({
  flow: {
    names: ['example-flow'],
    role: 'step',
    step: 'step2',
    emits: ['step2.complete'],
    subscribes: ['step1.complete']  // Manual dependency wiring!
  }
})

// Problems:
// 1. Jeder Step braucht separate Datei
// 2. Manuelles emits/subscribes wiring
// 3. Dependencies nicht aus Code ersichtlich
// 4. Fehleranfällig (typos in event names)
// 5. Schwer zu refactoren
```

**Neue Implementation (v1.0): Automatisches Wiring**

```typescript
// ✅ Compiler extrahiert alles automatisch

// server/workflows/example.ts
export default defineWorkflow({
  name: 'example-flow',
  handler: async (input, ctx) => {
    // Dependencies sind implizit durch Await-Chain!
    const result1 = await ctx.step('step1', async () => {
      return await processData(input)
    })
    
    // Compiler erkennt: step2 depends on step1
    const result2 = await ctx.step('step2', async () => {
      return await process2(result1)  // Nutzt result1
    })
    
    // Parallel steps: Compiler erkennt automatisch!
    const [result3, result4] = await Promise.all([
      ctx.step('step3', async () => {
        return await process3(result2)
      }),
      ctx.step('step4', async () => {
        return await process4(result2)  // Beide hängen von result2 ab
      })
    ])
    
    return { result3, result4 }
  }
})

// Compiler generiert automatisch:
// 1. State Machine mit Dependencies
// 2. Event subscriptions für Orchestrator
// 3. Step function registrations
// 4. UI Graph für Visualisierung
// 5. TypeScript Types für Auto-completion

// KEINE manuellen emits/subscribes mehr!
// KEINE separate Dateien pro Step!
// KEINE manuellen role definitions!
```

**Compiler Output: State Machine**

```typescript
// Auto-generiert vom Compiler
const stateMachine = {
  name: 'example-flow',
  states: [
    {
      id: 'step1',
      type: 'step',
      dependencies: [],              // Entry point
      next: ['step2']
    },
    {
      id: 'step2',
      type: 'step',
      dependencies: ['step1'],       // Auto-detected!
      next: ['step3', 'step4']
    },
    {
      id: 'step3',
      type: 'step',
      dependencies: ['step2'],
      next: ['end'],
      parallel: 'group1'             // Auto-detected parallel
    },
    {
      id: 'step4',
      type: 'step',
      dependencies: ['step2'],
      next: ['end'],
      parallel: 'group1'             // Same parallel group
    }
  ],
  entryPoints: ['step1'],            // Auto-detected
  exitPoints: ['end']
}
```

**Compiler-basierte Dependency Detection**

```typescript
// packages/nvent/src/runtime/workflow-compiler.ts
export class WorkflowCompiler {
  extractDependencies(ast: AST): DependencyGraph {
    const steps: Map<string, StepNode> = new Map()
    const dependencies: Map<string, Set<string>> = new Map()
    
    // 1. Traverse AST und sammle alle ctx.step() Calls
    traverse(ast, {
      AwaitExpression(path) {
        if (isStepCall(path.node)) {
          const stepId = getStepId(path.node)
          steps.set(stepId, extractStepNode(path.node))
        }
      }
    })
    
    // 2. Analyze data flow between steps
    for (const [stepId, node] of steps) {
      const deps = new Set<string>()
      
      // Find all identifiers used in this step
      traverse(node.handlerAst, {
        Identifier(path) {
          const binding = path.scope.getBinding(path.node.name)
          
          // Check if identifier comes from previous step
          if (binding && isStepResult(binding)) {
            const sourceStep = getSourceStep(binding)
            deps.add(sourceStep)
          }
        }
      })
      
      dependencies.set(stepId, deps)
    }
    
    // 3. Detect parallel steps (Promise.all)
    const parallelGroups = detectParallelGroups(ast)
    
    return { steps, dependencies, parallelGroups }
  }
  
  private detectParallelGroups(ast: AST): ParallelGroup[] {
    const groups: ParallelGroup[] = []
    
    traverse(ast, {
      CallExpression(path) {
        // Promise.all([...])
        if (isPromiseAll(path.node)) {
          const steps = extractParallelSteps(path.node)
          groups.push({
            id: generateGroupId(),
            steps,
            dependencies: extractGroupDependencies(path)
          })
        }
      }
    })
    
    return groups
  }
}
```

**Orchestrator nutzt State Machine**

```typescript
export class WorkflowOrchestrator {
  constructor(
    private worker: IIIWorker,
    private stateMachines: Map<string, StateMachine>
  ) {}
  
  async onStepCompleted(event: StepCompletedEvent) {
    const { runId, stepId } = event
    const state = await this.getWorkflowState(runId)
    const machine = this.stateMachines.get(state.workflowName)
    
    // Update state
    state.completedSteps.add(stepId)
    
    // Find next steps from State Machine
    const currentStep = machine.states.find(s => s.id === stepId)
    const nextSteps = currentStep.next
    
    // Check if dependencies satisfied
    for (const nextStepId of nextSteps) {
      const nextStep = machine.states.find(s => s.id === nextStepId)
      const allDepsComplete = nextStep.dependencies.every(dep =>
        state.completedSteps.has(dep)
      )
      
      if (allDepsComplete && !state.enqueuedSteps.has(nextStepId)) {
        // All dependencies complete → enqueue!
        await this.enqueueStep(runId, nextStepId, state)
        state.enqueuedSteps.add(nextStepId)
      }
    }
    
    await this.saveWorkflowState(runId, state)
  }
}
```

**Benefits: 90% weniger Code!**

```typescript
// Alte Implementation:
// - 10+ Dateien für komplexen Flow
// - ~500 LOC für Wiring
// - Fehleranfällig
// - Schwer zu debuggen

// Neue Implementation:
// - 1 Datei für gesamten Workflow
// - ~50 LOC für Business Logic
// - Type-safe
// - Auto-wired durch Compiler
// - Einfach zu debuggen (alle Steps an einem Ort)
```

---

## 7. Loop-Implementierung mit iii-queue

### 7.1 ForEach Pattern

```typescript
// Runtime Implementation
async function executeForEach<T, R>(
  items: T[],
  handler: (item: T, index: number) => Promise<R>,
  options: ForEachOptions,
  ctx: WorkflowContext
): Promise<R[]> {
  const { concurrency = 10, queue = 'workflow-loops' } = options
  
  // 1. Create loop state
  const loopId = `${ctx.runId}:loop-${Date.now()}`
  await ctx.state.set(`loop:${loopId}:total`, items.length)
  await ctx.state.set(`loop:${loopId}:completed`, 0)
  
  // 2. Enqueue all items
  const jobs = items.map((item, index) => ({
    loopId,
    index,
    item,
    handler: handler.toString(), // Serialized handler
    workflowContext: serializeContext(ctx)
  }))
  
  // 3. Submit to iii-queue
  await Promise.all(
    jobs.map(job => 
      worker.trigger({
        function_id: 'workflow::loop-item-executor',
        payload: job,
        action: TriggerAction.Enqueue({ queue })
      })
    )
  )
  
  // 4. Wait for completion via state
  const results = await waitForLoopCompletion(loopId, items.length)
  
  return results
}
```

### 7.2 Loop Item Executor (iii Function)

```typescript
// Auto-registered iii Function
worker.registerFunction(
  'workflow::loop-item-executor',
  async (payload: LoopItemPayload) => {
    const { loopId, index, item, handler, workflowContext } = payload
    
    // 1. Deserialize context
    const ctx = deserializeContext(workflowContext)
    
    // 2. Execute handler
    const handlerFn = eval(`(${handler})`)
    const result = await handlerFn(item, index)
    
    // 3. Store result
    await ctx.state.set(`loop:${loopId}:result:${index}`, result)
    
    // 4. Increment completed counter
    const completed = await ctx.state.get(`loop:${loopId}:completed`)
    await ctx.state.set(`loop:${loopId}:completed`, completed + 1)
    
    // 5. Publish progress event
    await worker.trigger({
      function_id: 'pubsub::publish',
      payload: {
        topic: `loop:${loopId}:progress`,
        data: { index, completed: completed + 1 }
      }
    })
    
    return result
  }
)
```

### 7.3 Nested Workflows in Loops

```typescript
// Loop mit Workflow-Aufruf
await ctx.forEach(items, async (item) => {
  // Jeder Loop-Durchlauf startet eigenen Workflow
  return await ctx.runWorkflow('process-item', { data: item })
})

// Internal implementation
async function runWorkflow(name: string, input: any) {
  // Trigger workflow as iii function
  return await worker.trigger({
    function_id: `workflow::${name}`,
    payload: {
      ...input,
      parentRunId: ctx.runId,
      parentWorkflow: ctx.workflowId
    }
  })
}
```

---

## 8. Type-Safety & Auto-Completion

### 8.1 Nuxt Auto-Imports

```typescript
// #nvent/workflows auto-import
declare module '#nvent/workflows' {
  export function defineWorkflow<TInput, TOutput>(config: {
    name: string
    handler: (input: TInput, ctx: WorkflowContext) => Promise<TOutput>
    description?: string
    timeout?: string | number
    triggers?: TriggerDefinition[]
    concurrency?: ConcurrencyConfig
  }): Workflow<TInput, TOutput>
}

// #functions auto-import (alle defineFunction aus /server/functions)
declare module '#functions' {
  export const generateDraft: (input: { topic: string }) => Promise<{ content: string }>
  export const summarize: (input: { text: string }) => Promise<{ summary: string }>
  // ... auto-generated für alle Functions
}
```

### 8.2 Template Generation

```typescript
// packages/nvent/src/module.ts
export default defineNuxtModule({
  async setup(options, nuxt) {
    // 1. Scan /server/functions
    const functions = await scanFunctions()
    
    // 2. Generate types
    addTemplate({
      filename: 'nvent-functions.d.ts',
      getContents: () => generateFunctionTypes(functions)
    })
    
    // 3. Scan /server/workflows
    const workflows = await scanWorkflows()
    
    // 4. Generate workflow registry
    addTemplate({
      filename: 'nvent-workflows.d.ts',
      getContents: () => generateWorkflowTypes(workflows)
    })
  }
})
```

### 8.3 Function Schema → TypeScript

```typescript
// Automatisch generiert aus defineFunction Schema
export const generateDraft: TypedFunction<
  { topic: string },
  { content: string; wordCount: number }
>

// Usage mit Auto-Completion
const result = await generateDraft({ topic: 'AI' })
//    ^? { content: string; wordCount: number }
```

---

## 9. UI Integration

### 9.1 Workflow Visualization

```vue
<!-- packages/app/components/WorkflowGraph.vue -->
<template>
  <VueFlow
    :nodes="graph.nodes"
    :edges="graph.edges"
    :fit-view-on-init="true"
  >
    <template #node-step="{ data }">
      <WorkflowStepNode 
        :label="data.label"
        :status="getStepStatus(data.id)"
        :result="getStepResult(data.id)"
      />
    </template>
    
    <template #node-loop="{ data }">
      <WorkflowLoopNode
        :label="data.label"
        :progress="getLoopProgress(data.id)"
        :total="data.itemCount"
      />
    </template>
  </VueFlow>
</template>

<script setup lang="ts">
import { useWorkflowRun } from '#nvent/composables'

const props = defineProps<{
  workflowName: string
  runId: string
}>()

// Fetch workflow graph (dry-run result)
const { graph } = await useWorkflowGraph(props.workflowName)

// Real-time status updates via iii-stream
const { status, events } = useWorkflowRun(props.runId)

function getStepStatus(stepId: string) {
  const event = events.value.find(e => e.stepId === stepId)
  return event?.status ?? 'pending'
}
</script>
```

### 9.2 Real-time Updates

```typescript
// composables/useWorkflowRun.ts
export function useWorkflowRun(runId: string) {
  const events = ref<WorkflowEvent[]>([])
  const status = ref<WorkflowStatus>('running')
  
  // Connect to iii-stream
  const channel = `workflow:${runId}:stream`
  
  onMounted(async () => {
    // Subscribe to workflow events
    const stream = await $fetch('/api/_iii/stream/subscribe', {
      method: 'POST',
      body: { channel }
    })
    
    // Listen for events
    const eventSource = new EventSource(stream.url)
    eventSource.onmessage = (e) => {
      const event = JSON.parse(e.data)
      events.value.push(event)
      
      if (event.type === 'workflow.completed') {
        status.value = 'completed'
      }
    }
  })
  
  return { events, status }
}
```

### 9.3 Loop Progress Visualization

```vue
<template>
  <div class="loop-node">
    <h3>{{ label }}</h3>
    <div class="progress-bar">
      <div 
        class="progress-fill" 
        :style="{ width: `${progressPercent}%` }"
      />
    </div>
    <p>{{ completed }} / {{ total }}</p>
    
    <!-- Expandable: Zeige alle Loop-Items -->
    <button @click="expanded = !expanded">
      {{ expanded ? 'Hide' : 'Show' }} Items
    </button>
    
    <div v-if="expanded" class="loop-items">
      <div 
        v-for="(item, i) in items" 
        :key="i"
        :class="['loop-item', item.status]"
      >
        Item {{ i }}: {{ item.status }}
      </div>
    </div>
  </div>
</template>
```

---

## 10. API Endpoints

### 10.1 Workflow Management

```typescript
// Server Routes

// GET /api/_workflows
// List all registered workflows
export default defineEventHandler(async () => {
  return await getWorkflowRegistry()
})

// GET /api/_workflows/:name
// Get workflow definition & graph
export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')
  const workflow = await getWorkflow(name)
  const graph = await dryRunWorkflow(name)
  
  return { workflow, graph }
})

// POST /api/_workflows/:name/start
// Start workflow run
export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')
  const input = await readBody(event)
  
  const runId = await startWorkflow(name, input)
  
  return { runId }
})

// GET /api/_workflows/:name/runs/:runId
// Get workflow run status
export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')
  const runId = getRouterParam(event, 'runId')
  
  const status = await getWorkflowRunStatus(name, runId)
  const events = await getWorkflowEvents(runId)
  const state = await getWorkflowState(runId)
  
  return { status, events, state }
})

// POST /api/_workflows/:name/runs/:runId/resume
// Resume workflow (für waitFor hooks)
export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')
  const runId = getRouterParam(event, 'runId')
  const data = await readBody(event)
  
  await resumeWorkflow(runId, data.event, data.payload)
  
  return { success: true }
})

// DELETE /api/_workflows/:name/runs/:runId
// Cancel workflow run
export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')
  const runId = getRouterParam(event, 'runId')
  
  await cancelWorkflow(runId)
  
  return { success: true }
})
```

### 10.2 Trigger Registration

```typescript
// Workflows können HTTP Triggers direkt in config haben
export default defineWorkflow({
  name: 'ai-content',
  handler,
  triggers: [
    {
      type: 'http',
      config: {
        method: 'POST',
        path: '/api/workflows/ai-content'
      }
    },
    {
      type: 'cron',
      config: {
        expression: '0 9 * * 1' // Every Monday 9am
      }
    }
  ]
})

// Auto-registered als iii Triggers
worker.registerTrigger({
  type: 'http',
  function_id: 'workflow::ai-content',
  config: {
    api_path: '/api/workflows/ai-content',
    http_method: 'POST'
  }
})
```

---

## 11. Workflow Lifecycle

### 11.1 Workflow States

```typescript
type WorkflowStatus = 
  | 'pending'      // Erstellt, noch nicht gestartet
  | 'running'      // Aktuell in Ausführung
  | 'waiting'      // Wartet auf Event (waitFor)
  | 'paused'       // Manuell pausiert
  | 'completed'    // Erfolgreich abgeschlossen
  | 'failed'       // Fehlgeschlagen
  | 'cancelled'    // Manuell abgebrochen
  | 'timeout'      // Timeout erreicht
```

### 11.2 Workflow Events

```typescript
// Event Types emitted via iii-stream
interface WorkflowEvent {
  id: string
  timestamp: string
  runId: string
  workflowName: string
  type: WorkflowEventType
  data: any
}

type WorkflowEventType =
  | 'workflow.started'
  | 'workflow.completed'
  | 'workflow.failed'
  | 'workflow.cancelled'
  | 'step.started'
  | 'step.completed'
  | 'step.failed'
  | 'step.retry'
  | 'loop.started'
  | 'loop.progress'
  | 'loop.completed'
  | 'wait.started'
  | 'wait.resumed'
  | 'state.updated'
```

### 11.3 Event Flow

```
1. HTTP Trigger → workflow::ai-content
                    ↓
2. workflow.started event → iii-stream
                    ↓
3. ctx.step('generate-draft')
   → Enqueue to iii-queue
   → step.started event
                    ↓
4. iii-queue executes → ai::generate-draft
                    ↓
5. Result stored in state
   → step.completed event
                    ↓
6. ctx.waitFor('approval')
   → wait.started event
   → Subscribe to pubsub topic
                    ↓
7. External POST /api/workflows/.../resume
   → Publish to pubsub
   → wait.resumed event
                    ↓
8. Continue execution
   → workflow.completed event
```

---

## 12. Error Handling & Retry

### 12.1 Step-Level Retry

```typescript
await ctx.step('fetch-data', async () => {
  return await externalAPI.fetch()
}, {
  retry: {
    maxAttempts: 3,
    backoff: 'exponential',
    initialDelay: 1000
  }
})

// Internal: Nutzt iii-queue retry mechanism
worker.registerTrigger({
  type: 'durable:subscriber',
  function_id: 'step::fetch-data',
  config: {
    topic: 'workflow-steps',
    queue_config: {
      maxRetries: 3,
      backoffType: 'exponential',
      backoffDelay: 1000
    }
  }
})
```

### 12.2 Workflow-Level Error Handling

```typescript
export default defineWorkflow({
  name: 'resilient-workflow',
  handler: async (input, ctx) => {
    try {
      const result = await ctx.step('risky-operation', async () => {
        return await riskyAPI.call()
      })
      
      return result
    } catch (error) {
      // Compensation logic
      await ctx.step('rollback', async () => {
        return await compensate()
      })
      
      // Re-throw or return error state
      return { success: false, error: error.message }
    }
  }
})
```

### 12.3 Dead Letter Queue

```typescript
// Failed steps landen in DLQ (iii-queue)
// Abrufbar via API

// GET /api/_workflows/dead-letters
export default defineEventHandler(async () => {
  const dlqItems = await worker.trigger({
    function_id: 'engine::queue::dlq_messages',
    payload: { topic: 'workflow-steps' }
  })
  
  return dlqItems
})

// POST /api/_workflows/dead-letters/retry
export default defineEventHandler(async (event) => {
  const { topic } = await readBody(event)
  
  await worker.trigger({
    function_id: 'iii::queue::redrive',
    payload: { topic }
  })
  
  return { success: true }
})
```

---

## 13. Migration von v0.4 zu v1.0

### 13.1 Von defineQueueWorker zu defineWorkflow

**Alt (v0.4 BullMQ):**
```typescript
// server/queues/example/first_step.ts
export default defineQueueWorker(async (job, ctx) => {
  const result = await processData(job.data)
  ctx.flow.emit('step1.complete', result)
  return result
})

export const config = defineQueueConfig({
  flow: {
    names: ['example-flow'],
    role: 'entry',
    step: 'first_step',
    emits: ['step1.complete']
  }
})
```

**Neu (v1.0 iii):**
```typescript
// server/workflows/example.ts
export default defineWorkflow({
  name: 'example-flow',
  handler: async (input, ctx) => {
    const result = await ctx.step('first-step', async () => {
      return await processData(input)
    })
    
    return result
  }
})
```

### 13.2 Von Flow Events zu Workflow Context

**Alt:**
```typescript
ctx.flow.emit('step1.complete', { data })
ctx.flow.on('step1.complete', handler)
```

**Neu:**
```typescript
// Events sind implizit durch Step-Completion
// Für explizite Events:
await ctx.stream.send('step1.complete', { data })

// Für Synchronisation:
await ctx.waitFor('step1.complete')
```

### 13.3 State Migration

**Alt:**
```typescript
await ctx.state.set('key', value)
const value = await ctx.state.get('key')
```

**Neu (identisch):**
```typescript
await ctx.state.set('key', value)
const value = await ctx.state.get('key')
```

State API bleibt kompatibel, nutzt nun iii-state statt Redis direkt.

---

## 14. Performance & Skalierung

### 14.1 Concurrency Control

```typescript
// Workflow-Level Concurrency (in defineWorkflow config)
export default defineWorkflow({
  name: 'my-workflow',
  concurrency: {
    max: 100,          // Max 100 parallel runs
    key: (input) => input.userId  // Concurrency per user
  },
  handler: async (input, ctx) => {
    // ...
  }
})

// Step-Level Concurrency (via iii-queue)
await ctx.step('process', handler, {
  queue: 'high-priority',
  concurrency: 10
})
```

### 14.2 Queue Routing

```typescript
// Different queues für different priorities
await ctx.step('critical', handler, {
  queue: 'critical-queue'
})

await ctx.step('background', handler, {
  queue: 'background-queue'
})

// iii-queue config
worker.registerTrigger({
  type: 'durable:subscriber',
  function_id: 'step::critical',
  config: {
    topic: 'critical-queue',
    queue_config: {
      concurrency: 50,
      priority: 10
    }
  }
})
```

### 14.3 State Caching

```typescript
// Internal: Cache layer für iii-state
class WorkflowStateProvider {
  private cache = new Map<string, any>()
  
  async get(key: string) {
    if (this.cache.has(key)) {
      return this.cache.get(key)
    }
    
    const value = await iiiState.get(key)
    this.cache.set(key, value)
    return value
  }
  
  async set(key: string, value: any) {
    this.cache.set(key, value)
    await iiiState.set(key, value)
  }
}
```

---

## 15. Observability

### 15.1 iii-otel Integration

Alle Workflow-Events, Step-Executions und Logs werden über **iii-observability** (OpenTelemetry) gesammelt:

```typescript
// Automatisch instrumentiert via iii-otel
import { trace, metrics, logs } from 'iii-otel'

// Step Execution wird automatisch getraced
worker.registerFunction(
  'workflow::ai-content::step::generate-draft',
  async (payload) => {
    // Auto-traced via iii-otel
    const span = trace.getActiveSpan()
    span.setAttribute('workflow.run_id', payload.runId)
    span.setAttribute('workflow.step_id', 'generate-draft')
    
    // Logs werden automatisch mit Trace verknüpft
    console.log('Generating draft...')
    // → iii-otel sammelt und tagged mit trace_id
    
    return await generateDraft(payload)
  }
)
```

### 15.2 Workflow-spezifische Traces

```typescript
// Workflow Run = Root Span
// Jeder Step = Child Span
// Nested Workflows = Linked Spans

{
  trace_id: 'abc123',
  spans: [
    {
      span_id: 'root',
      name: 'workflow.ai-content',
      attributes: {
        'workflow.name': 'ai-content',
        'workflow.run_id': 'run-xyz',
        'workflow.input': '{"topic":"AI"}'
      },
      children: [
        {
          span_id: 'step-1',
          name: 'step.generate-draft',
          attributes: {
            'step.name': 'generate-draft',
            'step.function_id': 'ai::generate-draft',
            'step.retry_attempt': 1
          },
          events: [
            { name: 'step.started', timestamp: '...' },
            { name: 'step.completed', timestamp: '...' }
          ]
        },
        {
          span_id: 'step-2',
          name: 'step.summarize',
          // Parallel zu step-1
        }
      ]
    }
  ]
}
```

### 15.3 UI Integration: Workflow Run Logs

```vue
<!-- packages/app/components/WorkflowRunLogs.vue -->
<template>
  <div class="workflow-logs">
    <h3>Logs für Run {{ runId }}</h3>
    
    <!-- Filterable Log Stream -->
    <div class="log-filters">
      <select v-model="logLevel">
        <option value="all">All Levels</option>
        <option value="error">Errors</option>
        <option value="warn">Warnings</option>
        <option value="info">Info</option>
      </select>
      
      <select v-model="stepFilter">
        <option value="all">All Steps</option>
        <option v-for="step in steps" :key="step">
          {{ step }}
        </option>
      </select>
    </div>
    
    <!-- Log Timeline -->
    <div class="log-timeline">
      <div 
        v-for="log in filteredLogs" 
        :key="log.id"
        :class="['log-entry', log.level]"
      >
        <span class="timestamp">{{ formatTime(log.timestamp) }}</span>
        <span class="step-name">{{ log.attributes['step.name'] }}</span>
        <span class="message">{{ log.body }}</span>
        
        <!-- Expandable: Full Trace Context -->
        <button @click="showTraceContext(log)">
          View in Trace
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useWorkflowLogs } from '#nvent/composables'

const props = defineProps<{ runId: string }>()

// Fetch logs via iii-otel API
const { logs, loading } = useWorkflowLogs(props.runId)

// Auto-updated via iii-stream
watchEffect(() => {
  // Neue Logs kommen via Stream
})
</script>
```

### 15.4 Composable: Workflow Logs

```typescript
// composables/useWorkflowLogs.ts
export function useWorkflowLogs(runId: string) {
  const logs = ref<WorkflowLog[]>([])
  
  // Fetch initial logs via iii-otel
  onMounted(async () => {
    const response = await worker.trigger({
      function_id: 'observability::query::logs',
      payload: {
        filter: {
          'workflow.run_id': runId
        },
        limit: 1000,
        order: 'asc'
      }
    })
    
    logs.value = response.logs
    
    // Subscribe to new logs via stream
    const stream = await worker.trigger({
      function_id: 'stream::subscribe',
      payload: {
        channel: `workflow:${runId}:logs`
      }
    })
    
    stream.on('log', (log) => {
      logs.value.push(log)
    })
  })
  
  return { logs }
}
```

### 15.5 State Timeline in UI

```vue
<!-- packages/app/components/WorkflowStateTimeline.vue -->
<template>
  <div class="state-timeline">
    <h3>State Changes</h3>
    
    <div class="timeline">
      <div 
        v-for="change in stateChanges" 
        :key="change.timestamp"
        class="state-change"
      >
        <div class="timestamp">{{ formatTime(change.timestamp) }}</div>
        <div class="key">{{ change.key }}</div>
        <div class="value">
          <pre>{{ JSON.stringify(change.value, null, 2) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// State changes werden auch über iii-state events getrackt
const { stateChanges } = useWorkflowState(props.runId)
</script>
```

### 15.6 Metrics Dashboard

```typescript
// Auto-collected metrics via iii-otel
const metrics = {
  // Workflow metrics
  'workflow.runs.total': counter({ labels: ['workflow_name', 'status'] }),
  'workflow.runs.active': gauge({ labels: ['workflow_name'] }),
  'workflow.duration': histogram({ labels: ['workflow_name'] }),
  
  // Step metrics
  'workflow.step.duration': histogram({ labels: ['workflow_name', 'step_name'] }),
  'workflow.step.retries': counter({ labels: ['workflow_name', 'step_name'] }),
  'workflow.step.errors': counter({ labels: ['workflow_name', 'step_name', 'error_type'] }),
  
  // Loop metrics
  'workflow.loop.items.total': counter({ labels: ['workflow_name', 'loop_id'] }),
  'workflow.loop.items.completed': counter({ labels: ['workflow_name', 'loop_id'] }),
  'workflow.loop.items.failed': counter({ labels: ['workflow_name', 'loop_id'] })
}
```

### 15.7 Trace Visualization

```vue
<!-- packages/app/components/WorkflowTraceView.vue -->
<template>
  <div class="trace-view">
    <!-- Waterfall Chart wie in iii-observability -->
    <div class="trace-waterfall">
      <div 
        v-for="span in trace.spans" 
        :key="span.span_id"
        :style="getSpanStyle(span)"
        class="span"
      >
        <div class="span-name">{{ span.name }}</div>
        <div class="span-duration">{{ span.duration }}ms</div>
        
        <!-- Hover: Show Logs -->
        <div class="span-logs">
          <div v-for="log in span.logs" :key="log.id">
            {{ log.body }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
```

---

## 16. Testing

### 16.1 Unit Testing Workflows

```typescript
// tests/workflows/ai-content.test.ts
import { testWorkflow } from '#nvent/testing'
import aiContentWorkflow from '~/server/workflows/ai-content'

describe('AI Content Workflow', () => {
  it('should generate and publish content', async () => {
    const { result, events, state } = await testWorkflow(
      aiContentWorkflow,
      { topic: 'AI' },
      {
        mocks: {
          'ai::generate-draft': async () => ({
            content: 'Mock content'
          }),
          'ai::summarize': async () => ({
            summary: 'Mock summary'
          })
        },
        autoApprove: ['approval-received']
      }
    )
    
    expect(result.success).toBe(true)
    expect(result.published).toBe(true)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'step.completed',
        stepName: 'generate-draft'
      })
    )
  })
})
```

### 16.2 Integration Testing

```typescript
// tests/integration/workflows.test.ts
import { startTestIIIEngine } from '#nvent/testing'

describe('Workflow Integration', () => {
  let engine: TestIIIEngine
  
  beforeAll(async () => {
    engine = await startTestIIIEngine()
  })
  
  afterAll(async () => {
    await engine.shutdown()
  })
  
  it('should execute workflow end-to-end', async () => {
    const runId = await engine.startWorkflow('ai-content', {
      topic: 'Test'
    })
    
    // Wait for completion
    const result = await engine.waitForCompletion(runId, {
      timeout: 10000
    })
    
    expect(result.status).toBe('completed')
  })
})
```

---

## 17. Implementierungsplan

### Phase 1: Core Runtime (2-3 Wochen)
- [x] Spec schreiben
- [ ] Workflow Context Implementation
- [ ] Step Execution mit iii-queue
- [ ] State Management via iii-state
- [ ] Basic Error Handling

### Phase 2: Loop & Parallelization (1-2 Wochen)
- [ ] forEach Implementation
- [ ] Queue-basierte Parallelisierung
- [ ] Progress Tracking
- [ ] Nested Workflow Support

### Phase 3: Compiler & Dry-Run (2 Wochen)
- [ ] AST Parser für Workflows
- [ ] Graph Extraction
- [ ] Dry-Run Engine
- [ ] Type Generation

### Phase 4: UI Integration (1-2 Wochen)
- [ ] Workflow Graph Component
- [ ] Real-time Updates
- [ ] Loop Progress Visualization
- [ ] Event Timeline

### Phase 5: Advanced Features (2 Wochen)
- [ ] waitFor / Hooks
- [ ] sleep Implementation
- [ ] Conditional Steps
- [ ] Compensation/Rollback

### Phase 6: Testing & Docs (1 Woche)
- [ ] Test Utilities
- [ ] Integration Tests
- [ ] Developer Docs
- [ ] Migration Guide

---

## 18. Offene Fragen

1. **Workflow Versioning**: Wie gehen wir mit Workflow-Updates um während laufende Runs existieren?
   - Option A: Skew Protection wie Vercel (Run bleibt auf Deploy-Version)
   - Option B: Migration Strategy (alte Runs migrieren)
   
2. **Long-running Workflows**: Wie persistieren wir Workflows die Wochen/Monate laufen?
   - iii-state für Checkpoint-Storage
   - Separate Persistence Layer?

3. **Workflow Dependencies**: Können Workflows andere Workflows als Dependencies haben?
   - Ja via ctx.runWorkflow()
   - Aber: Wie verhindert man zirkuläre Dependencies?

4. **Rate Limiting**: Wie limitieren wir Workflow-Starts?
   - Per User via Concurrency Key
   - Global Limits via iii-queue Config

5. **Debugging**: Wie debugged man einen Workflow lokal?
   - Dry-Run Mode
   - Local iii Engine
   - Step-by-Step Execution Mode?

---

## 19. Beispiel: Kompletter Workflow

```typescript
// server/workflows/medical-data-pipeline.ts
import { defineWorkflow } from '#nvent/workflows'
import { 
  fetchPatientData,
  extractFeatures,
  runMLModel,
  generateReport,
  sendNotification
} from '#functions'

export default defineWorkflow({
  name: 'medical-data-pipeline',
  description: 'Vollständige medizinische Datenverarbeitung mit ML und Review',
  timeout: '72h',
  triggers: [
    {
      type: 'http',
      config: {
        method: 'POST',
        path: '/api/workflows/medical-data-pipeline'
      }
    },
    {
      type: 'cron',
      config: {
        expression: '0 2 * * *' // Daily at 2 AM
      }
    }
  ],
  concurrency: {
    max: 50,
    key: (input) => input.studyId
  },
  
  handler: async (input: { studyId: string }, ctx) => {
    
    // Step 1: Fetch patient data
    const patientData = await ctx.step('fetch-patient-data', async () => {
      return await fetchPatientData({ studyId: input.studyId })
    }, {
      retry: { maxAttempts: 3 },
      timeout: '30s'
    })
    
    // Step 2: Process each DICOM series in parallel
    const features = await ctx.forEach(
      patientData.series,
      async (series, index) => {
        // Nested workflow for each series
        return await ctx.runWorkflow('process-dicom-series', {
          seriesId: series.id,
          studyId: input.studyId
        })
      },
      {
        concurrency: 5,
        queue: 'dicom-processing',
        timeout: '10m'
      }
    )
    
    // Step 3: Aggregate results
    await ctx.state.set('features', features)
    
    // Step 4: Run ML model
    const predictions = await ctx.step('ml-inference', async () => {
      return await runMLModel({ features })
    }, {
      queue: 'gpu-queue',
      timeout: '5m'
    })
    
    // Step 5: Wait for physician review (human-in-the-loop)
    await ctx.stream.send('review-ready', {
      studyId: input.studyId,
      predictions
    })
    
    const review = await ctx.waitFor('physician-review', {
      timeout: '48h'
    })
    
    // Step 6: Generate final report
    const report = await ctx.step('generate-report', async () => {
      return await generateReport({
        studyId: input.studyId,
        features,
        predictions,
        review
      })
    })
    
    // Step 7: Send notifications
    await ctx.step('send-notifications', async () => {
      return await sendNotification({
        recipients: patientData.recipients,
        report
      })
    })
    
    return {
      success: true,
      reportId: report.id,
      studyId: input.studyId
    }
  }
})
```

---

## 21. Production Deployment (mit offiziellem iii workflow worker)

### 21.1 Deployment Strategy

**Wichtig**: Wir nutzen den **offiziellen iii workflow worker** aus https://github.com/iii-hq/workers/tree/main/workflow

```
┌─────────────────┐     ┌──────────────────┐
│   Nuxt Server   │     │  iii Engine      │
│  (Web Requests) │────▶│  (Coordinator)   │
└─────────────────┘     └────────┬─────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
              ▼                  ▼                  ▼
     ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
     │ iii workflow   │ │ iii workflow   │ │ iii workflow   │
     │ worker         │ │ worker         │ │ worker         │
     │ (Official)     │ │ (Official)     │ │ (Official)     │
     │ Shard 0        │ │ Shard 1        │ │ Shard 2        │
     └────────────────┘ └────────────────┘ └────────────────┘
```

**Was läuft wo:**
- **Nuxt**: HTTP Requests, `workflow::start` Aufrufe, UI
- **iii Engine**: WebSocket Coordinator, Function Routing
- **Official Workflow Worker**: DAG Orchestration, Run Sharding, State Management

### 21.2 Deployment mit offiziellem Worker

**Kein eigener Worker-Code nötig!** Der offizielle Worker ist production-ready.

#### Docker Image

```bash
# Offizielles Image nutzen
docker pull ghcr.io/iii-hq/workers/workflow:latest
```

#### Deployment Architektur

```
┌─────────────────┐     ┌──────────────────┐
│   Nuxt Server   │     │  iii Engine      │
│  (Web Requests) │────▶│  (Coordinator)   │
└─────────────────┘     └────────┬─────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
              ▼                  ▼                  ▼
     ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
     │ Workflow       │ │ Workflow       │ │ Workflow       │
     │ Worker 1       │ │ Worker 2       │ │ Worker N       │
     │ (Orchestrator) │ │ (Orchestrator) │ │ (Orchestrator) │
     └────────────────┘ └────────────────┘ └────────────────┘
```

### 21.2 Standalone Worker CLI

```bash
# packages/nvent/bin/workflow-worker.js
#!/usr/bin/env node

import { startWorkflowWorker } from '../dist/runtime/workflow-worker.js'

const worker = await startWorkflowWorker({
  iiiUrl: process.env.III_URL || 'ws://localhost:49134',
  workflowsDir: process.env.WORKFLOWS_DIR || './server/workflows',
  functionsDir: process.env.FUNCTIONS_DIR || './server/functions',
  workerName: process.env.WORKER_NAME || 'nvent-workflow-worker',
  concurrency: parseInt(process.env.CONCURRENCY || '10')
})

console.log('Workflow worker started:', worker.id)

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down workflow worker...')
  await worker.shutdown()
  process.exit(0)
})
```

### 21.3 Nuxt Integration (kein separater Worker-Code nötig)

**nvent sorgt nur für die Workflow-Definitionen und ruft den offiziellen Worker:**

```typescript
// packages/nvent/src/module.ts
export default defineNuxtModule({
  async setup(options, nuxt) {
    // 1. Compile workflows zu DAG format
    const workflows = await compileWorkflows(layerInfos)
    
    // 2. Generate templates für Auto-imports
    addTemplate({
      filename: 'workflow-registry.mjs',
      getContents: () => generateWorkflowRegistry(workflows)
    })
    
    // 3. Add server imports
    addServerImports([
      { name: 'defineWorkflow', from: '#nvent/workflows' },
      { name: 'startWorkflow', from: '#nvent/workflows' }
    ])
    
    // 4. In dev: Watch workflow files
    if (nuxt.options.dev) {
      watchWorkflowFiles({
        nuxt,
        layerInfos,
        onRefresh: async () => {
          // Recompile workflows
          await compileWorkflows(layerInfos)
        }
      })
    }
    
    // KEIN eigener Worker-Code!
    // Der offizielle iii workflow worker läuft separat
  }
})
```

```typescript
// packages/nvent/src/runtime/workflow-execution.ts
// Wrapper um den offiziellen Worker

export async function startWorkflow(name: string, input: any) {
  const iii = useIii()
  const definition = await getCompiledWorkflow(name)
  
  // Nutze offiziellen workflow::start
  return await iii.trigger({
    function_id: 'workflow::start',
    payload: {
      definition: definition.dag,
      input
    }
  })
}
```

### 21.4 Docker Deployment mit offiziellem Worker

**Kein Dockerfile nötig!** Nutze das offizielle Image:

```bash
docker pull ghcr.io/iii-hq/workers/workflow:latest
```

### 21.5 Kubernetes Deployment (Offizieller Worker)

```yaml
# k8s/workflow-worker-deployment.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: iii-workflow-worker
spec:
  serviceName: iii-workflow-worker
  replicas: 3  # Run sharding über 3 Pods
  selector:
    matchLabels:
      app: iii-workflow-worker
  template:
    metadata:
      labels:
        app: iii-workflow-worker
    spec:
      containers:
      - name: workflow-worker
        image: ghcr.io/iii-hq/workers/workflow:latest  # Offizielles Image
        env:
        - name: III_URL
          value: "ws://iii-engine:49134"
        - name: WORKER_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: SHARD_ID
          valueFrom:
            fieldRef:
              fieldPath: metadata.name  # Pod ordinal wird zu shard ID
        - name: SHARD_TOTAL
          value: "3"
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: iii-workflow-worker
spec:
  clusterIP: None  # Headless service für StatefulSet
  selector:
    app: iii-workflow-worker
  ports:
  - port: 8080
    targetPort: 8080
```

### 21.6 Docker Compose Deployment

#### 21.6.1 Simple Setup (Development)

```yaml
# docker-compose.yml
version: '3.8'

services:
  # iii Engine (Coordinator)
  iii-engine:
    image: ghcr.io/iii-hq/engine:latest
    ports:
      - "49134:49134"
    environment:
      - III_LOG_LEVEL=info
    volumes:
      - iii-data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:49134/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  # Nuxt Application
  nuxt:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - III_URL=ws://iii-engine:49134
      - NODE_ENV=production
    depends_on:
      iii-engine:
        condition: service_healthy
    volumes:
      - ./server:/app/server:ro

  # Workflow Worker (Single Instance) - Offizielles Image
  workflow-worker:
    image: ghcr.io/iii-hq/workers/workflow:latest
    environment:
      - III_URL=ws://iii-engine:49134
      - WORKER_NAME=workflow-worker-0
      - SHARD_ID=0
      - SHARD_TOTAL=1
    depends_on:
      iii-engine:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 15s
      timeout: 5s
      retries: 3
    restart: unless-stopped

volumes:
  iii-data:
```

#### 21.6.2 Production Setup (Multi-Worker mit Run Sharding)

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  iii-engine:
    image: ghcr.io/iii-hq/engine:latest
    ports:
      - "49134:49134"
    environment:
      - III_LOG_LEVEL=warn
      - III_STORAGE_BACKEND=redis
      - REDIS_URL=redis://redis:6379
    volumes:
      - iii-data:/data
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: '2'
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:49134/health"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3

  nuxt:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - III_URL=ws://iii-engine:49134
      - NODE_ENV=production
    depends_on:
      iii-engine:
        condition: service_healthy
    deploy:
      replicas: 2
      resources:
        limits:
          memory: 2G
          cpus: '1'
    restart: unless-stopped

  # Workflow Worker Shard 0 (Offizielles Image)
  workflow-worker-0:
    image: ghcr.io/iii-hq/workers/workflow:latest
    environment:
      - III_URL=ws://iii-engine:49134
      - WORKER_NAME=workflow-worker-0
      - SHARD_ID=0
      - SHARD_TOTAL=3
    depends_on:
      iii-engine:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: '2'
        reservations:
          memory: 2G
          cpus: '1'
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 15s
      timeout: 5s
      retries: 3
    restart: unless-stopped

  # Workflow Worker Shard 1 (Offizielles Image)
  workflow-worker-1:
    image: ghcr.io/iii-hq/workers/workflow:latest
    environment:
      - III_URL=ws://iii-engine:49134
      - WORKER_NAME=workflow-worker-1
      - SHARD_ID=1
      - SHARD_TOTAL=3
    depends_on:
      iii-engine:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: '2'
        reservations:
          memory: 2G
          cpus: '1'
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 15s
      timeout: 5s
      retries: 3
    restart: unless-stopped

  # Workflow Worker Shard 2 (Offizielles Image)
  workflow-worker-2:
    image: ghcr.io/iii-hq/workers/workflow:latest
    environment:
      - III_URL=ws://iii-engine:49134
      - WORKER_NAME=workflow-worker-2
      - SHARD_ID=2
      - SHARD_TOTAL=3
    depends_on:
      iii-engine:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: '2'
        reservations:
          memory: 2G
          cpus: '1'
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 15s
      timeout: 5s
      retries: 3
    restart: unless-stopped

  # Monitoring (Optional)
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-data:/var/lib/grafana
      - ./monitoring/dashboards:/etc/grafana/provisioning/dashboards:ro
    depends_on:
      - prometheus

volumes:
  iii-data:
  redis-data:
  prometheus-data:
  grafana-data:
```

#### 21.6.3 Usage

```bash
# Development (Single Worker)
docker-compose up -d

# Production (Multi-Worker Sharded)
docker-compose -f docker-compose.prod.yml up -d

# Scale Workflow Workers (ohne Sharding - für simple workloads)
docker-compose up -d --scale workflow-worker=5

# View logs
docker-compose logs -f workflow-worker-0
docker-compose logs -f workflow-worker-1

# Check health
curl http://localhost:3001/health
```

#### 21.6.4 Run Sharding in Docker Compose

```typescript
// Worker reads shard config from environment
const shardId = parseInt(process.env.WORKFLOW_SHARD_ID || '0')
const totalShards = parseInt(process.env.WORKFLOW_SHARD_TOTAL || '1')

const orchestrator = new WorkflowOrchestrator({
  shardId,
  totalShards,
  iiiUrl: process.env.III_URL
})

// Only process runs assigned to this shard
orchestrator.on('tick', async (event) => {
  const { run_id } = event
  const assignedShard = hash(run_id) % totalShards
  
  if (assignedShard !== shardId) {
    console.log(`[shard-${shardId}] Ignoring run ${run_id} (belongs to shard ${assignedShard})`)
    return
  }
  
  await orchestrator.processTick(event)
})
```

### 21.7 Development vs Production

```typescript
// packages/nvent/src/module.ts
export default defineNuxtModule({
  async setup(options, nuxt) {
    if (nuxt.options.dev) {
      // Development: Embedded Worker
      nuxt.hook('ready', async () => {
        console.log('[nvent] Starting embedded workflow worker...')
        await startWorkflowWorker({
          iiiUrl: options.iiiUrl,
          workflows: await scanWorkflows(),
          embedded: true
        })
      })
    } else {
      // Production: External Worker erwartet
      console.log('[nvent] Production mode: Start workflow worker separately')
      console.log('[nvent] Run: npm run workflow:worker')
      console.log('[nvent] Or use docker-compose -f docker-compose.prod.yml up')
    }
  }
})
```

### 21.8 Health Checks

```typescript
// packages/nvent/src/runtime/workflow-worker.ts
export async function startWorkflowWorker(config) {
  const worker = registerWorker(config.iiiUrl, {
    workerName: config.workerName
  })
  
  // Health check endpoint
  const healthServer = createServer((req, res) => {
    if (req.url === '/health') {
      const health = {
        status: worker.connected ? 'healthy' : 'unhealthy',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        workflows: worker.registeredFunctions.length,
        shard: {
          id: config.shardId,
          total: config.totalShards
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(health))
    }
  })
  
  healthServer.listen(3001)
  
  return worker
}
```

### 21.9 Monitoring & Scaling

#### 21.9.1 Prometheus Configuration

```yaml
# monitoring/prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  # Workflow Workers
  - job_name: 'workflow-workers'
    static_configs:
      - targets:
        - 'workflow-worker-0:3001'
        - 'workflow-worker-1:3001'
        - 'workflow-worker-2:3001'
    metrics_path: '/metrics'
    
  # iii Engine
  - job_name: 'iii-engine'
    static_configs:
      - targets: ['iii-engine:49134']
    metrics_path: '/metrics'
    
  # Nuxt Server
  - job_name: 'nuxt'
    static_configs:
      - targets: ['nuxt:3000']
    metrics_path: '/api/_health/metrics'
```

#### 21.9.2 Metrics Export (Worker)

```typescript
// packages/nvent/src/runtime/workflow-worker.ts
import { register, Counter, Gauge, Histogram } from 'prom-client'

export class WorkflowMetrics {
  // Counters
  workflowsStarted = new Counter({
    name: 'workflow_started_total',
    help: 'Total number of workflows started',
    labelNames: ['workflow_name', 'shard_id']
  })
  
  workflowsCompleted = new Counter({
    name: 'workflow_completed_total',
    help: 'Total number of workflows completed',
    labelNames: ['workflow_name', 'status', 'shard_id']
  })
  
  stepsExecuted = new Counter({
    name: 'workflow_steps_executed_total',
    help: 'Total number of workflow steps executed',
    labelNames: ['workflow_name', 'step_id', 'status', 'shard_id']
  })
  
  // Gauges
  activeRuns = new Gauge({
    name: 'workflow_active_runs',
    help: 'Number of currently active workflow runs',
    labelNames: ['workflow_name', 'shard_id']
  })
  
  queueDepth = new Gauge({
    name: 'workflow_queue_depth',
    help: 'Number of workflow events waiting in queue',
    labelNames: ['queue_name', 'shard_id']
  })
  
  // Histograms
  workflowDuration = new Histogram({
    name: 'workflow_duration_seconds',
    help: 'Workflow execution duration',
    labelNames: ['workflow_name', 'shard_id'],
    buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600]
  })
  
  stepDuration = new Histogram({
    name: 'workflow_step_duration_seconds',
    help: 'Workflow step execution duration',
    labelNames: ['workflow_name', 'step_id', 'shard_id'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60]
  })
}

// Metrics endpoint
const metricsServer = createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('Content-Type', register.contentType)
    res.end(await register.metrics())
  } else if (req.url === '/health') {
    // ... health check
  }
})
```

#### 21.9.3 Kubernetes HPA (Auto-Scaling)

```typescript
// Metrics für Scaling-Entscheidungen:
- workflow.queue.depth         // Anzahl wartender Workflows
- workflow.runs.active         // Aktive Workflow-Runs
- workflow.step.queue.depth    // Anzahl wartender Steps
- worker.cpu.usage             // CPU Auslastung
- worker.memory.usage          // Memory Auslastung

// HPA Config:
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: workflow-worker-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: nvent-workflow-worker
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Pods
    pods:
      metric:
        name: workflow_queue_depth
      target:
        type: AverageValue
        averageValue: "100"
```

#### 21.9.4 Docker Compose Scaling

```bash
# Manual Scaling (ohne Sharding - für einfache Workloads)
docker-compose up -d --scale workflow-worker=5

# Mit Sharding: Manuelle Replika-Anpassung
# Bearbeite docker-compose.prod.yml und füge mehr Shards hinzu:

# Add workflow-worker-3
cat >> docker-compose.prod.yml << 'EOF'
  workflow-worker-3:
    build:
      context: .
      dockerfile: Dockerfile.workflow-worker
    environment:
      - III_URL=ws://iii-engine:49134
      - WORKER_NAME=workflow-worker-3
      - WORKFLOW_SHARD_ID=3
      - WORKFLOW_SHARD_TOTAL=4  # Update auch bei anderen Workers!
      - CONCURRENCY=20
      - NODE_ENV=production
    depends_on:
      iii-engine:
        condition: service_healthy
    volumes:
      - ./server/workflows:/app/server/workflows:ro
      - ./server/functions:/app/server/functions:ro
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: '2'
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 15s
      timeout: 5s
      retries: 3
    restart: unless-stopped
EOF

# Wichtig: WORKFLOW_SHARD_TOTAL bei ALLEN Workers aktualisieren!
# Dann: docker-compose -f docker-compose.prod.yml up -d
```

**Auto-Scaling mit Docker Swarm (Alternative):**

```yaml
# docker-compose.swarm.yml
version: '3.8'

services:
  workflow-worker:
    image: ghcr.io/iii-hq/workers/workflow:latest  # Offizielles Image
    environment:
      - III_URL=ws://iii-engine:49134
    deploy:
      replicas: 3
      update_config:
        parallelism: 1
        delay: 10s
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
      resources:
        limits:
          memory: 4G
          cpus: '2'
        reservations:
          memory: 2G
          cpus: '1'
      # Auto-scaling mit Swarm
      placement:
        constraints:
          - node.role == worker
    networks:
      - nvent-network

networks:
  nvent-network:
    driver: overlay
```

```bash
# Deploy mit Swarm (Offizieller Worker)
docker stack deploy -c docker-compose.swarm.yml nvent

# Scale
docker service scale nvent_workflow-worker=5

# Update auf neue Version
docker service update --image ghcr.io/iii-hq/workers/workflow:v2 nvent_workflow-worker
```

---

## 22. Zusammenfassung & Updates

Diese Spezifikation definiert ein umfassendes Workflow-System für nvent, das:

✅ **Developer-friendly** ist (einfache API ohne 'use workflow' Direktiven)  
✅ **iii-native** arbeitet (nutzt Workers, Functions, Triggers, State, Queues)  
✅ **Type-safe** ist (vollständige TypeScript-Integration)  
✅ **Visualisierbar** ist (Dry-Run für UI-Graphs, alte AnalyzedFlow Format)  
✅ **Skalierbar** ist (parallele Loops über iii-queue + horizontale Orchestrator-Skalierung)  
✅ **Observable** ist (vollständige iii-otel Integration für Logs & Traces)  
✅ **Nicht-blockierend** ist (Event-Driven State Machine, keine Node.js Blockierung!)  
✅ **Production-ready** ist (Separate Worker Deployment möglich)  
✅ **90% weniger Wiring** (Compiler-basierte Dependency Detection)  
✅ **Battle-tested** (nutzt **offiziellen iii workflow worker**)  

### Wichtigste Design-Entscheidungen

1. **Keine 'use workflow' Direktive**: defineWorkflow() Config-Object ist ausreichend
2. **Konsistente API**: Ähnlich zu defineFunction() - alles in einem Config-Object
3. **Nutzt offiziellen iii workflow worker**: ghcr.io/iii-hq/workers/workflow:latest
4. **Kein eigener Orchestrator-Code**: Der offizielle Worker macht DAG Orchestration
5. **Run Sharding statt Optimistic Locking**: iii-state hat KEIN CAS/version checking
6. **nvent = Developer Experience Layer**: Compiler, Type-Safety, UI, Nuxt Integration
7. **Event-Driven Orchestration**: Workflows blockieren NICHT, DAG + workflow::tick
8. **iii-otel Integration**: Alle Logs, Traces, Metrics über iii-observability
9. **Separate Worker Deployment**: Production-Deployment unabhängig von Nuxt
10. **Compiler-basiertes Wiring**: Dependencies automatisch aus Code extrahiert

### Architektur-Highlights

```typescript
// ❌ NICHT SO: Blockierende Execution
async function workflow() {
  await longStep()  // Blockiert Node.js!
  await waitFor()   // Blockiert für Tage!
}

// ✅ SO: Event-Driven DAG
defineWorkflow({
  handler: async (input, ctx) => {
    // Wird zu DAG kompiliert
    // Offizieller Worker führt Steps asynchron aus via workflow::tick
    // Keine Blockierung!
  }
})

// Nutzt den offiziellen Worker:
await iii.trigger({
  function_id: 'workflow::start',  // ← Offizieller Worker
  payload: { definition, input }
})
```

### Verbesserungen gegenüber v0.4

| Aspekt | v0.4 (BullMQ) | v1.0 (iii + Official Worker) |
|--------|---------------|------------------------------|
| **Code-Struktur** | 10+ Dateien pro Flow | 1 Datei pro Workflow |
| **Wiring** | Manuell (emits/subscribes) | Automatisch (Compiler) |
| **Dependencies** | Explizit deklarieren | Implizit durch Await |
| **Type-Safety** | Partiell | Vollständig |
| **Orchestration** | BullMQ Job Chains | DAG via workflow::start |
| **Orchestrator** | Eigener Code (BullMQ) | **Offizieller iii Worker** |
| **Skalierung** | BullMQ Concurrency | Run Sharding (Official Pattern) |
| **Race Conditions** | Möglich | Verhindert (Run Sharding) |
| **Observability** | Custom Logs | iii-otel (Traces + Metrics) |
| **UI Graph** | Manuell konfiguriert | Auto-generiert (Compiler) |
| **Long-Running** | Blockiert Node.js | Event-Driven (nicht blockierend) |
| **Code-Menge** | ~500 LOC | ~50 LOC (90% weniger!) |
| **Maintenance** | Eigener Orchestrator-Code | **Official Worker vom iii Team** |

### Was nvent beiträgt (Dev Experience Layer)

```typescript
// nvent fokussiert sich auf Developer Experience:
- ✅ Compiler (defineWorkflow → DAG für offiziellen Worker)
- ✅ Type Safety (auto-generated types)
- ✅ UI Visualisierung (VueFlow graphs)
- generateRegistryTemplate()          // Auto-imports
- watchQueueFiles()                   // File Watching
- Nuxt Module Structure               // Integration Pattern

// ➕ Neu hinzufügen
- compileWorkflowsRegistry()          // Workflow Compilation
- WorkflowCompiler                    // AST → State Machine
- WorkflowOrchestrator                // Event-Driven Coordinator
- generateWorkflowTypesTemplate()     // #workflows auto-imports
```

### Integration Points

1. **Workflow Definition**: /server/workflows/*.ts mit defineWorkflow()
2. **Function Definition**: /server/functions/*.ts mit defineFunction()
3. **Orchestrator**: Dedizierter iii Worker (embedded oder standalone)
4. **Registry**: Erweitert bestehende Registry um Workflows
5. **Templates**: Generiert Types für Auto-completion
6. **Logs & Traces**: Automatisch via iii-otel
7. **UI**: Real-time Updates via iii-stream (bestehende Components)
8. **State**: Persistent via iii-state mit Optimistic Locking
9. **Queue**: iii-queue mit Concurrency Control per runId

### Orchestrator Skalierung (beantwortet User-Frage)

**Problem**: Mehrere Orchestrator → Queue durcheinander?

**Lösung (basiert auf offiziellem iii-hq/workers/workflow)**:

```typescript
// Offizielle Empfehlung: "shard workflow::tick events by run_id 
// so that all writes for a given run land on one owning instance"

// 1. Run Sharding (Infrastructure oder Application-level)
const shard = hash(runId) % totalShards
// → Alle Events für run_abc gehen immer zu Pod 0
// → Alle Events für run_def gehen immer zu Pod 1

// 2. In-Process Locks (innerhalb eines Workers)
class WorkflowOrchestrator {
  private runLocks = new Map<string, Promise<void>>()
  // Serialisiert writes für einen Run innerhalb des Prozesses
}

// 3. Deterministic IDs für Idempotency
const sessionId = `wf_${runId}_${stepId}@r${attempt}`
// → Re-delivery eines Tick ist no-op (harness dedup)

// ❌ KEIN CAS/Optimistic Locking verfügbar!
// iii-state (SDK 0.20.0) hat:
// - KEIN state::cas
// - KEIN if_match / version checking
// - state::set ist unconditional overwrite
// 
// Daher: Run sharding ist DIE Lösung für Concurrency
```

**Deployment:**
```yaml
# Kubernetes StatefulSet mit Shard Assignment
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: workflow-orchestrator
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: orchestrator
        env:
        - name: WORKFLOW_SHARD_ID
          value: "$(POD_ORDINAL)"  # 0, 1, 2
        - name: WORKFLOW_SHARD_TOTAL
          value: "3"
```

**Resultat**: 
- ✅ Keine Race Conditions (run sharding)
- ✅ Sicheres horizontales Scaling
- ✅ Kein distributed locking nötig
- ✅ Bei Pod-Ausfall: Automatic reassignment

### Wiring-Vereinfachung (beantwortet User-Frage)

**Ist komplexes Wiring noch nötig?** → **NEIN!**

```typescript
// v0.4: Manuelles Wiring
export const config = {
  emits: ['step1.complete'],        // ❌ Manuell
  subscribes: ['step0.complete'],   // ❌ Manuell
  role: 'step'                      // ❌ Manuell
}

// v1.0: Automatisches Wiring
const result = await ctx.step('step1', ...)  // ✅ Auto-wired!
// Compiler extrahiert Dependencies aus Await-Chain
// Kein manuelles emits/subscribes mehr nötig!
```

Die Implementation baut auf bestehenden nvent-Komponenten auf und erweitert sie um eine mächtige Workflow-Abstraction, die komplexe Multi-Step-Prozesse einfach definierbar macht - **ohne Node.js zu blockieren** und **ohne manuelles Wiring**.

### Integration mit offiziellem iii workflow worker ⭐

**Wichtige Entdeckung**: iii hat bereits einen production-ready workflow worker!

- **Repository**: https://github.com/iii-hq/workers/tree/main/workflow
- **Features**: DAG orchestration, run sharding, deterministic idempotency
- **Constraint**: iii-state (SDK 0.20.0) hat **KEIN CAS/optimistic locking**
- **Lösung**: Run sharding + in-process locks (wie im offiziellen Worker)

**Zwei Integrations-Optionen:**

**Option A: Nutze offiziellen Worker direkt** ✅ Empfohlen
```typescript
// defineWorkflow() kompiliert zu workflow::start Format
await iii.trigger({
  function_id: 'workflow::start',
  payload: {
    definition: {
      nodes: [/* auto-generated DAG */]
    },
    notify: { function_id: 'nvent::workflow-completed' }
  }
})
```

**Option B: Eigener Worker nach offiziellem Pattern**
```typescript
// Folge dem Pattern:
// - Run sharding by run_id
// - In-process locks (no distributed locking)
// - Deterministic session IDs (wf_<runId>_<nodeId>@r<attempt>)
// - DAG-based execution
```

**Was wir beitragen:**
- ✅ Developer-friendly API (defineWorkflow statt raw DAG)
- ✅ Type-Safety (auto-generated types)
- ✅ Compiler (ctx.step → DAG mit dependencies)
- ✅ UI Integration (VueFlow visualization)
- ✅ Nuxt Module (auto-discovery, HMR)
- ✅ iii-otel Wrapper (logs/traces per run)

**Next Steps**: 
1. ✅ Evaluiere offiziellen workflow worker (https://github.com/iii-hq/workers/tree/main/workflow)
2. Entscheide: Nutze offiziell oder baue eigenen nach Pattern
3. Implementiere Compiler: defineWorkflow() → DAG
4. Integriere in Nuxt Module (Registry + Templates)
5. Baue UI Components für Visualisierung
