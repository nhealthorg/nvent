# Streams

## Motivation

Streams sind von States getrennt. Die eigentlichen Stream-Daten werden ausschließlich im `iii-stream` Worker persistiert; der Workflow Worker hält nur eine kleine Referenz-Registry im Run-Record, damit er weiß, welche Streams zu einem Run gehören und wie sie wieder gefunden werden können.

Die Workflow Engine abstrahiert den Zugriff auf `iii-stream` und sorgt dafür, dass:
1. Nur Stream-Referenzen im Run-Record registriert werden, keine Stream-Payloads.
2. Ein einheitliches Key-Mapping (`[RUN_ID]:[stream_name]`) verwendet wird.
3. Jede Stream-Interaktion automatisch auditiert wird.

## Scope & Key-Konzept

- **`workflow_run`** — Das zentrale Metadaten-Objekt des Runs.
   - Relevantes Feld: `stream_ids: string[]` — Liste der Stream-Namen/IDs, die für diesen Run bekannt sind.
   - Wichtig: Hier liegen nur Referenzen. Die eigentlichen Stream-Daten leben im `iii-stream` Worker.

- **Stream-Channel** (für `iii-stream`):  
  Format: `[RUN_ID]:[stream_name]` (z.B. `r_abc123:realtime-progress`)

> **Hinweis Separator:** Standardmäßig wird `:` verwendet. Da manche Adapter (Dateisysteme, Brücken) `:` als Sonderzeichen interpretieren könnten, ist die Engine so vorbereitet, dass ein Wechsel auf `_` (z.B. `r_abc123_progress`) zentral an einer Stelle erfolgen kann.

## Neue Funktionen

```
workflow::stream-publish  → schreibt einen durablen Stream-Eintrag in iii-stream + aktualisiert die Referenz-Registry
workflow::stream-list     → liest die Registry aus dem Run-Record und macht Streams damit discoverable
```

## Write-Flow (stream-publish)

Wenn `workflow::stream-publish { run_id, stream, data }` aufgerufen wird:

1. **Stream-Referenz in Registry**  
   `state::update { scope: workflow_run, key: "[RUN_ID]", ops: [{ type: "append", path: "stream_ids", value: "[stream]" }] }`  
   (Nur Referenz, keine Stream-Daten.)

2. **Eigentlicher Publish**  
   `stream::set { stream_name: "[stream]", group_id: "[RUN_ID]", item_id: "[AUTO_ID]", data }`  
   (Dies nutzt den nativen `iii-stream` Worker; der Worker persistiert die Daten dort, nicht im `workflow_run` Record.)

3. **Automatisches Audit**  
   Die Workflow Engine ruft intern `workflow::trace-write` auf:
   - `event_name: "workflow.stream.publish"`
   - Attributes: `workflow.stream.name`, `workflow.run_id`, `workflow.node_uid`, `workflow.stream.item_id`
   - Data-Preview: Eine gekürzte Vorschau der Payload (analog zu States: max. 500 Zeichen).

## Read-Flow (stream-list)

Die UI benötigt eine Liste aller aktiven Streams eines Runs, um Tabs oder Anzeigen dynamisch zu rendern.

Wenn `workflow::stream-list { run_id }` aufgerufen wird:

1. **Registry lesen**  
   `state::get { scope: workflow_run, key: "[RUN_ID]" }` → extrahiert `run.stream_ids`.
2. **Response**  
   `["realtime-progress", "logs", "metrics", ...]`

## Developer Experience (Node.js / Python)

Der Entwickler muss sich nicht um `run_id` Präfixe, Group-IDs oder Channel-Zusammensetzungen kümmern:

```ts
// Im Workflow-Kontext
await ctx.workflow.stream.publish('progress', { percent: 45 })
```

Die Engine ergänzt die `run_id`, pflegt die Registry und schreibt den Audit-Trace im Hintergrund.

## UI-Integration

1. Die UI ruft `workflow::stream-list { run_id }` ab.
2. Für jeden Stream-Namen abonniert die UI den Stream im `iii-stream` Worker über `stream_name + group_id = run_id`.
3. Die Audit-Timeline zeigt an, wann welcher Node Daten in welchen Stream geschrieben hat.

## Cleanup

Beim Löschen eines Runs (Cleanup-Flow) sind für Streams keine expliziten Löschoperationen im `iii-stream` nötig, da diese flüchtig sind. Der Eintrag in `workflow_run` verschwindet automatisch mit dem Löschen des Run-Records.

## Referenz

- Verhält sich analog zu [States](./states.md), aber mit eigener Persistenz im `iii-stream` Worker.
- Nutzt `iii-stream` für Persistenz, Lookup und Realtime-Benachrichtigungen.
- Nutzt `workflow_run` nur für die Referenz-Registry, nicht für Stream-Daten.