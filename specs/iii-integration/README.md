# iii Engine Integration Spec for nvent

## Overview
This document describes the architecture and conventions for deeply integrating the iii engine (https://github.com/iii-hq/iii) into nvent, replacing all previous event/flow/queue logic with iii as the single backend engine. The goal is a plug-and-play developer experience for Nuxt/Nitro, fully adopting iii's primitives and conventions, and supporting a custom nhealth console app.

## Goals
- Use iii engine as the only backend engine for flows, triggers, and state.
- Adopt iii's Function/Trigger/Discovery model natively in nvent.
- Provide a Nuxt/Nitro-native DX: auto-discovery, HMR, config, and composability.
- Enable seamless use of iii SDKs (Node.js, Python, Rust) for custom workers.
- Integrate with a custom nhealth console for observability and management.
- No backward compatibility with previous nvent adapters or config.

## Core Concepts
- **Function**: A unit of work, registered via SDK, can be local or remote.
- **Trigger**: Defines what causes a function to run (HTTP, cron, queue, state, etc).
- **Discovery**: All functions/triggers are auto-registered and discoverable.
- **Config**: Single config file (YAML/TS) for engine and triggers.
- **Engine**: iii engine runs as a process (binary or Docker), exposes WebSocket/HTTP APIs.

## Architecture
- nvent module starts and manages the iii engine process (dev/prod).
- Functions are defined in the Nuxt/Nitro app (e.g. `server/functions/`), auto-registered via SDK.
- Triggers are defined via config or code, auto-registered.
- SDK handles communication with the engine (register, trigger, observe).
- Custom nhealth console connects to engine for real-time state, traces, and management.

## Developer Experience
- Zero-config start: `npx nvent dev` spins up iii engine and Nuxt/Nitro.
- Functions auto-discovered from project structure.
- Triggers defined in config or colocated with functions.
- Hot reload for function/trigger changes.
- Console app for live inspection, health, and management.

## Example Project Structure
```
my-app/
  nvent.config.ts   # nvent/iii config (merged into iii config.yaml)
  server/
    functions/
      hello.ts      # export default function, plus trigger config
      ...
  ...
```

## Example Function
```ts
// server/functions/hello.ts
import { registerFunction, registerTrigger } from 'iii-sdk';

registerFunction({ id: 'hello' }, async (input) => {
  return { message: `Hello, ${input.name}!` };
});

registerTrigger({
  type: 'http',
  function_id: 'hello',
  config: { api_path: 'hello', http_method: 'GET' },
});
```

## Engine Management
- nvent module manages iii engine lifecycle (start/stop/reload).
- Configurable via `nvent.config.ts` (merged to iii config.yaml).
- Supports local binary, Docker, or remote engine.

## Console Integration
- Custom nhealth console app connects to iii engine for:
  - Function/trigger discovery
  - Trace and state inspection
  - Health and metrics
  - Manual triggering and debugging

## Open Questions
- How to handle engine upgrades and versioning?
- How to support multi-language workers (Node.js, Python, Rust) in Nuxt context?
- How to extend triggers/types for Nuxt-specific use cases?

## Next Steps
1. Prototype nvent module that starts iii engine and registers a sample function/trigger.
2. Define config schema and auto-discovery conventions.
3. Build console integration for live health/tracing.
4. Document migration path for existing nvent users (if needed).
