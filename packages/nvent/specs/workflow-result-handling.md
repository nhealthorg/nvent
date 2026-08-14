# Workflow Result Handling — Memory-first by default

Status: Draft

## Ziel
Standardverhalten des Workflow-Workers so ändern, dass Funktions-Resultate "in-memory" an die nächste Funktion weitergereicht werden und nur auf ausdrücklichen Wunsch in den persistenten `store` geschrieben werden. Dadurch sollen Workflows mit großen Datenmengen (Loops, Binärdaten, Streams) deutlich effizienter und speichersparender laufen.

## Motivation
- Aktuell werden Ergebnisse standardmäßig in den `store` geschrieben. Bei großen Ergebnissen oder vielen Iterationen führt das zu Speicher- und I/O-Problemen.
- Entwickler sollen einfach zwischen verschiedenen Speicher-/Transport-Strategien wählen können: sparsame `memory`-Weitergabe (Default), persistenter `store`-Write (opt-in) oder fortlaufender `stream` (für große/binary Daten oder Backpressure-Szenarien).

## Design-Übersicht

1. Default-modus: `memory`
   - Ergebnisse einer Funktion werden als Referenz/Handle in speicherinternen (prozesslokalen) memory-channels an die aufrufende Engine weitergereicht.
   - Die nächste Funktion im Workflow erhält das Ergebnis direkt aus Memory (zero-copy wenn möglich, oder als kurzlebige Referenz).
   - Memory-Objekte sind kurzlebig: sie werden nach erfolgreicher Übergabe gelöscht oder gemäß GC-Policy (siehe unten) freigegeben.

2. Opt-in persistenter Modus: `store`
   - Entwickler setzen bei einem `trigger`/`call` Option `returnType: 'store'`.
   - In diesem Fall wird das Result im normalen Workflow-`store` (persistenter Key-Value Store) abgelegt und der Aufrufer erhält einen Key/Ref.
   - UI / Operatoren sehen diese Writes und können Hinweise/Warnings anzeigen (z.B. "große Datenmenge wurde persistent gespeichert").

3. Stream-Modus: `stream` (optional)
   - Für sehr große oder unbounded Outputs (z. B. Binary, große JSON-Arrays) kann `returnType: 'stream'` genutzt werden.
   - Implementation: Ergebnis wird als Stream-Channel (chunked) bereitgestellt. Konsument kann Kanal lesen, unterstützt Backpressure.
   - Vorteile: geringer Speicherbedarf, geeignet für Binary/Media-Processing.

## API / Schema

### 1) Funktionsaufruf / Trigger-Request

Zusatz-Felder (optional) im Trigger-Request-Objekt:

```ts
{
  function_id: string,
  payload: unknown,
  timeoutMs?: number,
  options?: {
    returnType?: 'memory' | 'store' | 'stream',
    // nur relevant für 'stream'
    streamChunkSize?: number,
  }
}
```

### 2) Funktionsergebnis-Formate

- `memory` (Standard)
  - Rückgabe: das originale Ergebnisobjekt wird prozessintern zum nächsten Step weitergereicht.
  - Laufzeit-Shape: `{ type: 'memory', ref?: string }` intern, für Devtools kann ein kurzes Preview geliefert werden.

- `store`
  - Rückgabe: `{ type: 'store', key: string }` — der Konsument kann den Key lesen oder `store.get(key)` aufrufen.
  - Hinweis: Der persistente `key`/Ref wird automatisch durch den Worker generiert und in das Workflow-Run-Objekt eingetragen (z. B. `run.result.storeKey`), sodass nachfolgende Steps und die UI leicht darauf zugreifen können. `storeKey` ist nicht konfigurierbar durch den Aufrufer.

- `stream`
  - Rückgabe: `{ type: 'stream', channelRef: StreamChannelRef }` (siehe `iii` stream channel helpers).
 
## Implementation-Details (aktuelle `defineWorkflow.ts`-Logik)

Die JavaScript/TypeScript-Implementierung kompiliert die deklarative Workflow-API in eine statische DAG-Definition. Die relevante Datei ist `packages/nvent/src/runtime/nitro/utils/defineWorkflow.ts`.

Wichtige Punkte, wie `ctx.call()` / `ctx.node()`-Optionen aktuell verarbeitet werden:

- Argumentparsing (`parseCallArguments`):
  - `ctx.call(...)` akzeptiert variable Argumente:
    - 1 Argument → `functionId` (nodeId = functionId), `input = 'run_input'`.
    - 2 Argumente → entweder `(nodeId, functionId)` (wenn beide strings) oder `(functionId, input)`.
    - 3+ Argumente → `(nodeId, functionId, input)`.
  - Wenn das letzte Argument eine Option-ähnliche Struktur ist (erkennbar via `isCallOptions`), wird es als `callOptions` extrahiert.

- Aktuelle Call-/Node-Optionen (`CallOptions`):
  - `label?: string`
  - `queue?: string`
  - `runtime?: 'nodejs'|'python'|'rust'|'unknown'`
  - `engine_retry?: { max_attempts?: number }`
  - `retry?: { max_attempts?: number }` (Alias)

- Mapping in `buildFunctionSpec`:
  - `buildFunctionSpec(functionId, callOptions)` erzeugt entweder nur den Function-String oder ein Objekt `{ id, runtime?, queue?, engine_retry? }`.

- Merge mit Registry in `ctx.node`:
  - `ctx.node(id, spec)` normalisiert `spec.function` zu `fnSpec` und validiert `id`.
  - Falls `spec.retry` vorhanden ist und `fnSpec.engine_retry` fehlt, wird `spec.retry` auf `fnSpec.engine_retry` gemappt.
  - Fehlende Werte (z. B. `runtime`, `queue`, `engine_retry`, `label`) werden via `getFunctionExecutionConfig(fnSpec.id)` aus dem Registry ergänzt. Registry-Werte füllen nur Lücken — explizit gesetzte Call/Node-Optionen haben Vorrang.

- Input‑Normalisierung & Abhängigkeiten:
  - `normalizeInput(...)` wandelt `spec.input` in `{ from: 'run_input' | 'node:x' }`-Shapes.
  - `collectNodeRefs(...)` scannt `spec.input` nach `node:`-Refs und trägt diese als Datenabhängigkeiten (`depends_on`) in den Node ein.

- Fanout / Loop / Parallel:
  - `ctx.loop`, `ctx.foreach` und `ctx.all` erzeugen `fanout`-Definitionen und steuern `controlFrontier`/`parallelCollector`, sodass die resultierende DAG das gewünschte Laufzeitverhalten widerspiegelt.

- Wichtige Lücke bezüglich `returnType`:
  - Obwohl die Spezifikation `returnType` / `streamChunkSize` als Optionsfelder beschreibt, werden diese Felder in der aktuellen `defineWorkflow.ts`-Implementierung **nicht** in die erzeugte `nodeDef` geschrieben. Das heißt: die Information gelangt derzeit nicht zum Worker.

### Empfehlung: Wie `returnType` durchgereicht werden sollte

Damit der Worker Entscheidungen über Memory/Store/Stream treffen kann, schlage ich folgende, minimal-invasive Änderungen vor:

1) `CallOptions` erweitern (Beispiel):

```ts
type CallOptions = {
  label?: string
  queue?: string
  runtime?: 'nodejs' | 'python' | 'rust' | 'unknown'
  engine_retry?: { max_attempts?: number }
  retry?: { max_attempts?: number }
  // neu:
  returnType?: 'memory' | 'store' | 'stream'
  streamChunkSize?: number
  onMemoryFail?: 'store' | 'error'
}
```

2) In `ctx.call` / `ctx.node` die Policy in `nodeDef` ablegen (separat von `function`):

```ts
const nodeDef: any = {
  label: spec.label,
  depends_on: dependsOn,
  input: normalizeInput(spec.input, dataDeps),
  fanout: typeof spec.fanout === 'string' ? { over: spec.fanout } : spec.fanout,
  function: fnSpec,
  result: {
    returnType: parsed.callOptions?.returnType ?? 'memory',
    streamChunkSize: parsed.callOptions?.streamChunkSize,
    onMemoryFail: parsed.callOptions?.onMemoryFail,
  }
}
```

3) Worker‑Seite: Beim Ausführen einer Node liest der Worker `nodeDef.result` und implementiert:
  - `memory` → result in MemoryPool ablegen und Handle an nächsten Schritt übergeben
  - `store` → persist und `run.result.storeKey` setzen (Key generiert der Worker)
  - `stream` → Stream-Channel öffnen (chunking according to `streamChunkSize`)

4) Observability: Bei jedem result‑Handling ein Event emitten (`result:memory|result:store|result:stream`) mit Metadaten (runId, nodeId, payloadSize).

Diese Änderungen stellen sicher, dass `returnType` tatsächlich vom Aufrufer übergeben werden kann und vom Worker ausgewertet wird, während bestehende Call-Optionen und Registry‑Füllung unangetastet bleiben.
## Memory-Lifecycle & GC

- Kurzlebige Memory-Objekte leben nur so lange, wie:
  - sie noch von einer laufenden Pipeline-Instanz referenziert werden, ODER
  - bis zur konfigurierten TTL (default z. B. 60s) abläuft.
- Nach erfolgreicher Übergabe an die nächste Funktion wird die Referenz entfernt; falls kein Konsument existiert, gilt die Memory-Referenz als candidate for GC.
- Admin-Konfigurierbare Limits: `maxMemorySizePerRun`, `maxMemoryItems`, `memoryObjectTtlMs`.

## Fehlerfall & Fallback

- Wenn Memory-Weitergabe fehlschlägt (z. B. Ziel-Worker crashed, OOM):
  - Option A: Fallback auf `store` (configurable per-run / per-call): `onMemoryFail: 'store' | 'error'`.
  - Option B: Fehlerpropagation nach unten (Default: Fehler zurück an Aufrufer).

## Binary-Handling

- Memory kann opaque binary buffers/ArrayBuffers transportieren. Implementierung sollte möglichst zero-copy nutzen (Transferable objects, Node Buffer references) wenn Host-Plattform das unterstützt.
- Stream ist empfohlen für große Binaries; chunking-Strategie und checksums optional.

## UI / Devtools Hinweise

- Bei Start eines Calls zeigt UI die erwartete `returnType`-Strategie an (z. B. Badge: "memory (default)").
- Wenn ein Step explizit `returnType: 'store'` setzt, zeigt UI Warning/Badge: "Persistent store write — kann bei großen Daten zu Kosten führen" und bietet Option "confirm".
- Timeline / Inspector: Memory-Übergaben werden als "in-memory" Connections visualisiert; `store`-Writes als persistent nodes; `stream` als Kanal mit Live-Bytes/Chunks.

## Migration

- Keine Abwärtskompatibilität: Das neue Standardverhalten ist `memory`. Vorhandene Workflows, die auf automatisch persistierte Store‑Writes vertrauen, müssen aktiv angepasst (z. B. `returnType: 'store'`) werden.

## Implementierungs-Guidance für Worker-Engine

1. Core: Support für ein Ergebnis-Envelope mit `type`-Tag (`memory|store|stream`).
2. Memory-Pool: Implementiere ein pro-run Memory-Store mit TTL und limits.
3. Store-Write: Gate über existing `store` APIs — make atomic write when requested.
4. Stream: Reuse existing stream channel APIs (siehe `createChannel` / `ChannelWriter` in `iii-browser-sdk`).
5. Observability: Emit events `result:memory`, `result:store`, `result:stream` für Devtools and audit logs.

Weitere Details zur Stream-Channel‑Integration sind in der separate Spec dokumentiert: [stream-channels.md](packages/nvent/specs/stream-channels.md)

## Security & Quotas

- Memory-Objects sollten nur von workflow-internals referenziert werden.
- Store-Writes behalten bestehende RBAC / auth-guards.
- Per-tenant quotas for persistent store writes to avoid abuse.

## Open Fragen

- Welche Default-TTL ist sinnvoll? Vorschlag: `60000 ms` (60s) initial.
- Default maxMemorySizePerRun? Vorschlag: 64MB per-run default, configurable.
- Soll `returnType` auch auf function-Definition-Level (z.B. function metadata) konfigurierbar sein?

## Beispiele (in `defineWorkflow`)

1) Default — in-memory (kein Store‑Write)

```ts
export const wfDefault = defineWorkflow({
  name: 'wf-default',
  handler: async (input, ctx) => {
    // Aufruf einer Funktion als Node; default: returnType = 'memory'
    const stepA = await ctx.call('stepA', 'wf::stepA', input)
    // stepA ist eine Referenz auf das Node‑Ergebnis (wird im DAG als node:stepA referenziert)
    return stepA
  }
})
```

2) Expliziter persistenter Store‑Write

```ts
export const wfStore = defineWorkflow({
  name: 'wf-store-write',
  handler: async (input, ctx) => {
    // explizit persistent speichern; Worker generiert den store-Key
    const stepA = await ctx.call('stepA', 'wf::stepA', input, { returnType: 'store' })
    return stepA
  }
})
```

3) Stream für große Daten (Node‑Form, mit vorgeschlagener `result`-Policy)

```ts
export const wfStream = defineWorkflow({
  name: 'wf-stream',
  handler: async (input, ctx) => {
    // expliziter Node mit Result‑Policy (siehe Empfehlung oben)
    await ctx.node('emitLarge', {
      function: { id: 'wf::emitLargeData' },
      input,
      // Beachte: `result` ist Teil der vorgeschlagenen Erweiterung
      result: { returnType: 'stream', streamChunkSize: 64 * 1024 }
    })
    return { status: 'started' }
  }
})
```

## TypeScript Interfaces (Vorschlag)

```ts
export type ResultEnvelope = MemoryResult | StoreResult | StreamResult

export interface MemoryResult {
  type: 'memory'
  /** Optional reference id for debugging/inspectors */
  ref?: string
}

export interface StoreResult {
  type: 'store'
  /** Key generated by the worker and persisted in the store */
  key: string
}

export interface StreamResult {
  type: 'stream'
  channelRef: StreamChannelRef
}

export interface RunResult {
  /** Last observed result envelope for this run */
  last?: ResultEnvelope
  /** If the last result was persisted, this contains the store key */
  storeKey?: string
}
```

## Zusammenfassung

Die vorgeschlagene Änderung reduziert I/O- und Speicherbelastung für Standard-Workflows, bietet aber weiterhin Opt-in-Möglichkeiten für persistente Speicherung und Streaming. Die Spezifikation ist bewusst pragmatisch gehalten — als nächsten Schritt würde ich:

1. Implementation-API skizzieren (Worker-intern: MemoryPool, Envelope, fallbacks).
2. Änderungen an Developer-Docs & Playground-UI vornehmen.
3. Integration-Tests/Benchmarks für large payloads aufsetzen.

Wenn du möchtest, schreibe ich als nächsten Schritt die konkrete API/Typen (TS-Interfaces) und ein Mini-Implementierungs-Plan mit Code-Snippets in `packages/nvent/src/`.
