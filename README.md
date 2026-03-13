# Nvent

Event-driven workflow orchestration for Nuxt with pluggable adapters. Start with zero dependencies using built-in memory/file adapters, scale to PostgreSQL or Redis for production.

## ✨ Features

- 🚀 **Zero Setup**: Start instantly with built-in memory/file adapters
- 🔄 **Job Queue**: Reliable job processing with retries and concurrency control
- 🎭 **Flow Orchestration**: Event-driven multi-step workflows
- ⏰ **Triggers**: Time-based (cron, delays), webhook, and manual triggers
- ⏸️ **Await Patterns**: Pause flows for time delays or webhook confirmations
- 🔌 **Pluggable Adapters**: Choose your backend - Memory, File, Redis, or PostgreSQL
- 📊 **Event Sourcing**: Complete audit trail with immutable event streams
- 🎨 **Development UI**: Real-time monitoring, flow diagrams, and debugging
- 📦 **Auto-discovery**: Filesystem-based function registry
- 🚀 **Production Ready**: Horizontal scaling with PostgreSQL or Redis
- 🔍 **Full Observability**: Real-time logs, metrics, and event streams

## 📦 Adapters

Nvent uses three types of adapters that can be mixed and matched:

### Queue Adapters
Process jobs with retries, concurrency, and scheduling:
- **memory** - Development (built-in, no persistence)
- **file** - Single instance with persistence (built-in)
- **redis** - Production with BullMQ (`@nvent-addon/adapter-queue-redis`)
- **postgres** - Production with pg-boss (`@nvent-addon/adapter-queue-postgres`)

### Store Adapters
Store flow metadata, state, and trigger data:
- **memory** - Development (built-in)
- **file** - Local persistence (built-in)
- **redis** - Production (`@nvent-addon/adapter-store-redis`)
- **postgres** - Production with optimized schema (`@nvent-addon/adapter-store-postgres`)

### Stream Adapters
Real-time event distribution and pub/sub:
- **memory** - Development (built-in, single instance)
- **redis** - Production with Redis Pub/Sub (`@nvent-addon/adapter-stream-redis`)
- **postgres** - Production with LISTEN/NOTIFY (`@nvent-addon/adapter-stream-postgres`)


## 🚀 Quick Start

### Installation

```bash
# Core package (includes built-in memory/file adapters)
npm install nvent

# Optional: UI for monitoring and debugging
npm install @nvent-addon/app

# Optional: PostgreSQL adapters (recommended for production)
npm install @nvent-addon/adapter-queue-postgres
npm install @nvent-addon/adapter-store-postgres
npm install @nvent-addon/adapter-stream-postgres

# Alternative: Redis adapters
npm install @nvent-addon/adapter-queue-redis
npm install @nvent-addon/adapter-store-redis
npm install @nvent-addon/adapter-stream-redis
```

## ⚙️ Configuration

### Development Setup (Zero Config)

Uses built-in memory adapters - perfect for getting started:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nvent']
})
```

### Development with Persistence

Use file adapters to persist data between restarts:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nvent'],
  
  nvent: {
    connections: {
      file: {
        dataDir: '.data'  // Will create .data/queue, .data/store subdirs
      }
    },
    
    queue: {
      adapter: 'file',
      worker: {
        concurrency: 2
      }
    },
    
    store: {
      adapter: 'file'
    },
    
    stream: {
      adapter: 'memory'  // File stream not recommended (use memory for dev)
    }
  }
})
```

### Production with PostgreSQL (Recommended)

Single database for all adapters with schema isolation:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: [
    '@nvent-addon/adapter-queue-postgres',
    '@nvent-addon/adapter-store-postgres',
    '@nvent-addon/adapter-stream-postgres',
    'nvent',
    '@nvent-addon/app'  // Optional UI
  ],
  
  nvent: {
    // Shared PostgreSQL connection
    connections: {
      postgres: {
        connectionString: process.env.DATABASE_URL
        // or individual settings:
        // host: 'localhost',
        // port: 5432,
        // database: 'nvent',
        // user: 'postgres',
        // password: 'postgres'
      }
    },
    
    queue: {
      adapter: 'postgres',
      schema: 'nvent_queue',  // Separate schema for queue tables
      worker: {
        concurrency: 5,
        autorun: true
      }
    },
    
    store: {
      adapter: 'postgres',
      schema: 'nvent_store',  // Separate schema for store tables
      prefix: 'nvent'
    },
    
    stream: {
      adapter: 'postgres',  // Uses LISTEN/NOTIFY
      prefix: 'nvent'
    },
    
    flow: {
      stallDetection: {
        enabled: true,
        stallTimeout: 1800000,  // 30 minutes
        checkInterval: 900000   // 15 minutes
      }
    }
  }
})
```

### Production with Redis

High-throughput setup for distributed systems:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: [
    '@nvent-addon/adapter-queue-redis',
    '@nvent-addon/adapter-store-redis',
    '@nvent-addon/adapter-stream-redis',
    'nvent',
    '@nvent-addon/app'
  ],
  
  nvent: {
    // Shared Redis connection
    connections: {
      redis: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD
      }
    },
    
    queue: {
      adapter: 'redis',
      prefix: 'nvent',
      worker: {
        concurrency: 10
      }
    },
    
    store: {
      adapter: 'redis',
      prefix: 'nvent'
    },
    
    stream: {
      adapter: 'redis',
      prefix: 'nvent'
    }
  }
})
```

### Hybrid Setup

Mix adapters based on your needs:

```ts
// Example: PostgreSQL for persistence, Redis for real-time streams
export default defineNuxtConfig({
  modules: [
    '@nvent-addon/adapter-queue-postgres',
    '@nvent-addon/adapter-store-postgres',
    '@nvent-addon/adapter-stream-redis',
    'nvent'
  ],
  
  nvent: {
    connections: {
      postgres: {
        connectionString: process.env.DATABASE_URL
      },
      redis: {
        host: process.env.REDIS_HOST,
        port: 6379
      }
    },
    
    queue: { adapter: 'postgres', schema: 'nvent_queue' },
    store: { adapter: 'postgres', schema: 'nvent_store' },
    stream: { adapter: 'redis' }  // Redis for low-latency pub/sub
  }
})
```

## 📝 Usage Examples

### Simple Function

Create a function in `server/functions/`:

```typescript
// server/functions/send-email.ts
import { defineFunctionConfig, defineFunction } from '#imports'

export const config = defineFunctionConfig({
  queue: { name: 'emails' }
})

export default defineFunction(async (input, ctx) => {
  const { to, subject, body } = input
  
  // Use context for logging
  ctx.logger.log('info', 'Sending email', { to, subject })
  
  // Your email logic
  await sendEmail(to, subject, body)
  
  return { sent: true, timestamp: new Date().toISOString() }
})
```

Enqueue from anywhere in your app:

```typescript
// API route, event handler, etc.
await $nvent.queue.enqueue('emails', {
  name: 'send-email',
  data: {
    to: 'user@example.com',
    subject: 'Welcome!',
    body: 'Thanks for signing up'
  }
})
```

### Event-Driven Flow

Multi-step workflows with automatic orchestration:

```typescript
// server/functions/example/first_step.ts
import { defineFunctionConfig, defineFunction } from '#imports'

export const config = defineFunctionConfig({
  queue: { name: 'example_queue' },
  flow: {
    name: 'example-flow',
    role: 'entry',  // Entry point of the flow
    step: 'first_step',
    emits: ['first_step.completed']
  }
})

export default defineFunction(async (input, ctx) => {
  ctx.logger.log('info', `Starting step ${ctx.jobId}`)
  
  // Your business logic
  const result = await processData(input)
  
  // Emit event to trigger next steps
  await ctx.flow.emit('first_step.completed', { result })
  
  return { ok: true }
})
```

```typescript
// server/functions/example/second_step.ts
import { defineFunctionConfig, defineFunction } from '#imports'

export const config = defineFunctionConfig({
  queue: { name: 'example_queue' },
  flow: {
    name: 'example-flow',
    role: 'step',
    step: 'second_step',
    subscribes: ['first_step.completed'],  // Triggered by first step
    emits: ['second_step.completed']
  }
})

export default defineFunction(async (input, ctx) => {
  // Input is keyed by event name
  const firstStepData = input['first_step.completed']
  
  ctx.logger.log('info', 'Processing second step', { receivedData: firstStepData })
  
  await processMoreData(firstStepData)
  
  await ctx.flow.emit('second_step.completed', { done: true })
  
  return { ok: true }
})
```

Start flows via triggers or manually:

```typescript
// Via API - flow starts automatically when triggered
// See trigger examples below

// Query flow status
const running = await $nvent.flow.isRunning('example-flow', runId)
const runs = await $nvent.flow.getRunningFlows('example-flow')

// Cancel if needed
await $nvent.flow.cancel()  // Uses flowId from context
```

### Triggers

Automatically start flows based on time, webhooks, or manual triggers:

#### Time-Based Triggers (Cron)

```typescript
// server/functions/scheduled-report.ts
import { defineFunctionConfig, defineFunction } from '#imports'

export const config = defineFunctionConfig({
  queue: { name: 'reports' },
  flow: {
    name: 'daily-report-flow',
    role: 'entry',
    step: 'generate-report',
    triggers: {
      define: {
        name: 'daily-report-schedule',
        type: 'time',
        scope: 'global',
        displayName: 'Daily Report',
        description: 'Generate daily report at 9 AM'
      },
      subscribe: ['daily-report-schedule'],
      mode: 'auto',
      config: {
        cron: '0 9 * * *'  // Every day at 9 AM
      }
    }
  }
})

export default defineFunction(async (input, ctx) => {
  const report = await generateDailyReport()
  await sendReport(report)
  return { generated: true }
})

// Common cron patterns:
// '*/5 * * * *'  - Every 5 minutes
// '0 * * * *'    - Every hour
// '0 9 * * *'    - Daily at 9 AM
// '0 9 * * 1'    - Every Monday at 9 AM
// '0 0 1 * *'    - First day of month
```

#### Manual Triggers

```typescript
// server/functions/notification-flow.ts
import { defineFunctionConfig, defineFunction } from '#imports'

export const config = defineFunctionConfig({
  queue: { name: 'notifications' },
  flow: {
    name: 'notification-flow',
    role: 'entry',
    step: 'send-notification',
    triggers: {
      define: {
        name: 'manual.send-notification',
        type: 'manual',
        scope: 'flow',
        displayName: 'Send Notification',
        description: 'Manually trigger notification'
      },
      subscribe: ['manual.send-notification'],
      mode: 'auto'
    }
  }
})

export default defineFunction(async (input, ctx) => {
  const triggerData = input.trigger?.data
  
  await sendNotification(triggerData)
  return { sent: true }
})

// Trigger via UI at /_nvent or programmatically
```

### Await Patterns

Pause flow execution for time delays or webhook confirmation:

#### Time Delay (awaitAfter)

```typescript
// server/functions/notification-with-delay.ts
import { defineFunctionConfig, defineFunction } from '#imports'

export const config = defineFunctionConfig({
  queue: { name: 'notifications' },
  flow: {
    name: 'notification-confirmation-flow',
    role: 'entry',
    step: 'send-notification',
    emits: ['notification.sent'],
    awaitAfter: {
      type: 'time',
      delay: 10000  // Wait 10 seconds after step completes
    }
  }
})

export default defineFunction(async (input, ctx) => {
  await sendNotification(input)
  
  // Emit event - but next step won't run for 10 seconds
  await ctx.flow.emit('notification.sent', { notificationId: ctx.runId })
  
  return { sent: true }
})
```

#### Webhook Approval (awaitBefore)

```typescript
// server/functions/process-approval.ts
import { defineFunctionConfig, defineFunction, defineAwaitRegisterHook } from '#imports'

export const config = defineFunctionConfig({
  queue: { name: 'approvals' },
  flow: {
    name: 'webhook-approval-flow',
    role: 'step',
    step: 'process-approval',
    subscribes: ['approval.requested'],
    awaitBefore: {
      type: 'webhook',
      method: 'POST',
      timeout: 300000,  // 5 minutes
      timeoutAction: 'fail'
    }
  }
})

// Hook called when webhook URL is generated
export const onAwaitRegister = defineAwaitRegisterHook(async (webhookUrl, awaitData, ctx) => {
  // Send webhook URL via email, Slack, etc.
  await sendApprovalRequest(webhookUrl, awaitData)
  
  ctx.logger.log('info', 'Approval webhook generated', { url: webhookUrl })
})

export default defineFunction(async (input, ctx) => {
  // This only runs AFTER webhook is called
  const approval = ctx.trigger  // Webhook payload
  
  if (!approval?.approved) {
    throw new Error(`Approval denied: ${approval?.comment}`)
  }
  
  await processApprovedRequest(approval)
  return { approved: true }
})
```

### Using State

Share data between flow steps:

```typescript
export const config = defineFunctionConfig({
  queue: { name: 'order_queue' },
  flow: {
    name: 'process-order',
    role: 'entry',
    step: 'process_order'
  }
})

export default defineFunction(async (input, ctx) => {
  // Store state that survives across steps
  await ctx.state.set('orderId', input.orderId)
  await ctx.state.set('total', input.total, { ttl: 3600000 }) // 1 hour TTL
  
  // Retrieve state later
  const orderId = await ctx.state.get('orderId')
  
  // Delete when done
  await ctx.state.delete('orderId')
  
  return { processed: true }
})
```

## 🎨 Development UI

Install the monitoring UI:

```bash
npm install @nvent-addon/app
```

Add to your Nuxt config:

```ts
export default defineNuxtConfig({
  modules: ['nvent', '@nvent-addon/app']
})
```

**Important:** Import the module's styles in your main CSS file to enable Tailwind scanning:

```css
/* app/assets/css/main.css or your main CSS file */
@import "tailwindcss";
@import "@nuxt/ui";
@import "@nvent-addon/app";
```

The UI is available in two ways:

**1. As a built-in route** (enabled by default):

Navigate to `http://localhost:3000/_nvent` in your browser.

**2. As a component in your app**:

Add the `<NventApp />` component anywhere in your pages:

```vue
<template>
  <div>
    <NventApp />
  </div>
</template>
```

You can customize the route configuration:

```ts
export default defineNuxtConfig({
  modules: ['nvent', '@nvent-addon/app'],
  nventapp: {
    route: true,              // Enable/disable built-in route (default: true)
    routePath: '/_nvent',     // Customize route path (default: '/_nvent')
    layout: false             // Layout to use: false (no layout), 'default', 'admin', etc. (default: false)
  }
})
```

The UI provides:

- 📊 **Dashboard** - Queue stats and active flows
- 🔄 **Flow Visualizer** - Interactive flow diagrams
- ⚡ **Triggers** - Manage schedules and webhooks  
- 📝 **Event Timeline** - Real-time event stream
- 📋 **Logs** - Filterable logs by flow/step
- 🔍 **Job Inspector** - View job details and retry history

## 🏗️ Architecture

### Pluggable Adapters

Nvent uses a three-tier adapter system:

1. **Queue Adapter**: Job processing and scheduling
   - Built-in: `memory`, `file`
   - PostgreSQL: `@nvent-addon/adapter-queue-postgres` (pg-boss)
   - Redis: `@nvent-addon/adapter-queue-redis` (BullMQ)

2. **Store Adapter**: Document and key-value storage
   - Built-in: `memory`, `file`
   - PostgreSQL: `@nvent-addon/adapter-store-postgres`
   - Redis: `@nvent-addon/adapter-store-redis`

3. **Stream Adapter**: Event sourcing and real-time distribution
   - Built-in: `memory`, `file`
   - PostgreSQL: `@nvent-addon/adapter-stream-postgres` (LISTEN/NOTIFY)
   - Redis: `@nvent-addon/adapter-stream-redis` (Redis Streams + Pub/Sub)

### Event Sourcing

Every flow operation is stored as an event in streams:

```
{prefix}:flow:<runId>  (default: nvent:flow:<runId>)
├─ flow.start
├─ step.started
├─ log
├─ step.completed
├─ step.started
├─ log
├─ step.completed
└─ flow.completed
```

Terminal states: `flow.completed`, `flow.failed`, `flow.cancel`, `flow.stalled`

### Real-time Distribution

With Redis stream adapter, events are broadcast via Pub/Sub for instant UI updates (<100ms latency).

### Function Context

Every function receives a rich context:

```typescript
{
  jobId: string              // BullMQ job ID
  queue: string              // Queue name
  flowId: string             // Flow run UUID
  flowName: string           // Flow definition name
  stepName: string           // Current step name
  logger: {
    log(level, msg, meta)    // Structured logging
  },
  state: {
    get(key)                 // Get flow-scoped state
    set(key, value, opts)    // Set with optional TTL
    delete(key)              // Delete state
  },
  flow: {
    emit(eventName, data)    // Emit flow event to trigger subscribed steps
    startFlow(name, input)   // Start nested flow
    cancelFlow(name, runId)  // Cancel a running flow
    isRunning(name, runId?)  // Check if flow is running
    getRunningFlows(name)    // Get all running instances
  }
}
```

## 🤝 Contributing

Contributions welcome! Please read our architecture docs first:

1. Review [specs/v0.4/current-implementation.md](./specs/v0.4/current-implementation.md)
2. Check [specs/roadmap.md](./specs/roadmap.md) for planned features
3. Open an issue to discuss changes
4. Submit a PR with tests

### Development Setup

```bash
# Install dependencies
yarn install

# Start playground with dev UI
cd playground
yarn dev

# Run tests
yarn test
```

## 📄 License

[MIT License](./LICENSE) - Copyright (c) DevJoghurt

## 📢 Notice: iii Engine Integration and License

This project integrates the iii engine (https://github.com/iii-hq/iii) for event-driven orchestration. The iii engine is licensed under the Elastic License 2.0 (ELv2):

- You may use, modify, and redistribute the iii engine, including for commercial purposes.
- You may NOT offer the iii engine as a managed service (SaaS) or as part of a competing service to Elastic.
- You must include the original license and notices in any redistribution.
- For most integration and internal/embedded use cases, ELv2 is permissive.

See [engine/LICENSE](https://github.com/iii-hq/iii/blob/main/engine/LICENSE) for full terms.