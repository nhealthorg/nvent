# Specification: Workflow Streams in nvent

Dieses Dokument beschreibt explizite Echtzeit-Streams innerhalb eines Workflow-Runs.
Workflow-Status ist standardmaessig stream-basiert; Polling bleibt als Fallback fuer Recovery/Snapshot.

## 1. Zielbild

- Entwickler senden in Workflow-Nodes gezielt Events, z. B. Chat-Chunks, Fortschritt oder Zwischenergebnisse.
- Frontend kann diese Events pro Run live abonnieren.
- Keine implizite Umstellung der Workflow-Orchestrierung auf Stream-Betrieb.

## 2. Workflow Runtime API

In workflow-fähigen Funktionen steht ctx.workflow.stream zur Verfügung:

```ts
export default defineFunction({
  workflow: true,
  handler: async (_input, ctx) => {
    await ctx.workflow?.stream.send('chat-update', { text: 'chunk-1' })
    await ctx.workflow?.stream.send('chat-update', { text: 'chunk-2' })
  },
})
```

### ctx.workflow.stream.send(type: string, data?: Record<string, unknown>)

- type ist der Event-Typ (z. B. progress, chat-update, token).
- data ist das Payload-Objekt.
- Intern wird workflow::stream-publish aufgerufen.
- Event-Isolation erfolgt über run_id (group_id).

## 3. Frontend API

Zwei Composables bilden die Standard-DX:

### useWorkflow

```ts
const workflow = useWorkflow()
const started = await workflow.run('test-wf', { text: 'hello' })

// started:
// {
//   run_id: string,
//   stream: { streamName: 'nworkflow', groupId: run_id },
//   raw: unknown
// }
```

### useWorkflowStream

```ts
const stream = useWorkflowStream(started.stream)

const progress = stream.listen<{ message: string }>('progress')
const count = stream.listen<{ message: string; count: number }>('count')
const agentEvents = stream.listenEvents('agents.*')

// optional: später auf anderen Run wechseln
// stream.subscribe(otherStarted.stream)
```

### Verhalten von listen(type)

- Gibt Ref<T[]> zurück.
- Sammelt alle Payloads für den angegebenen Event-Typ.
- Typen sind pro Event-Typ vom Entwickler festlegbar.

### Verhalten von listenEvents(pattern)

- Gibt Ref<WorkflowStreamEvent<T>[]> zurueck.
- Unterstuetzt exact type (`phase`) und Prefix-Pattern (`agents.*`).
- Liefert Event-Metadaten (`type`, `run_id`, `node_uid`, `ts_unix_ms`) fuer UI-Projektionen.

## 4. Transport und Mapping

- Stream-Name: nworkflow (kanonisch)
- Group-ID: run_id
- Event-Form: { type, data, run_id, node_uid?, ts_unix_ms }
- Triggerpfad: ctx.workflow.stream.send(...) -> nworkflow::stream-publish -> iii stream module -> WebSocket (/_iii/stream/{stream}/{group}).

## 5. Security

- Streams sind run-spezifisch über group_id = run_id getrennt.
- Zugriff erfolgt über bestehende Browser-Auth/RBAC-Regeln des nvent/iii-Setups.
- Wer keinen Zugriff auf den Run-Kontext hat, soll auch keine Run-Streams konsumieren können.
- Stream-Proxy erzwingt Join-Guard: nur kanonischer Stream (`nworkflow`) und gueltiges run_id-Format.

## 6. DX-Prinzipien

- Eine Standard-Startfunktion (useWorkflow.run).
- Ein Standard-Subscriber (useWorkflowStream).
- Event-Kanaele sind typisierte listen(type)-Aufrufe plus listenEvents(prefix) fuer Bereichsprojektionen.
- Run-Overview ist stream-first; Polling fuer Status ist Fallback.

## 7. Implementierungsstatus

1. [x] workflow stream send in Node.js/Python Workflow-Context verfügbar.
2. [x] useWorkflow und useWorkflowStream in runtime app composables implementiert.
3. [x] Playground-UI auf explizite Workflow-Events umgestellt.

