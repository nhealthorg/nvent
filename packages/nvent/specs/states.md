# States

## Motivation

`state::list` (iii-state) unterstützt keinen Key-Prefix-Filter – es wird nur `scope` akzeptiert und alle Einträge zurückgegeben. Um States effizient pro Run abzurufen, ohne alle Runs zu laden, brauchen wir eine **Key-Registry** pro Run.

## Scope-Konzept

- **`workflow_run_state`** — enthält die tatsächlichen State-Werte pro Run.  
  Key-Format: `[RUN_ID]:[key_name]` (z.B. `r_abc123:count`)

- **`workflow_run`** — zentrale Run-Metadaten. Der Run-Record enthält u.a. ein `state_keys`-Feld.  
  Key: `[RUN_ID]` (ein Record pro Run)  
  Relevantes Feld: `state_keys: string[]` — Liste der User-Keys, die für diesen Run gesetzt wurden.

> **Hinweis Separator:** `:` ist die Redis-Konvention und in den meisten Backends problemlos. Sollte ein Adapter (z.B. file-based, bridge) `:` als Sonderzeichen behandeln oder Konflikte mit internen Key-Schemas auftreten, kann der Separator auf `_` gewechselt werden (z.B. `r_abc123_count`). Der Separator ist intern in der Workflow Engine zentralisiert und muss nur an einer Stelle geändert werden.

## Neue Funktionen

```
workflow::state-set     → setzt einen Wert + aktualisiert Registry
workflow::state-get     → liest einen Wert
workflow::state-update  → atomares Update (nutzt state::update)
workflow::state-delete  → löscht einen Wert + entfernt Key aus Registry
workflow::state-list    → liest Registry, holt dann alle Werte einzeln
```

## Write-Flow (state-set)

Wenn `workflow::state-set { run_id, key, value }` aufgerufen wird:

1. `state::set { scope: workflow_run_state, key: "[RUN_ID]:[key]", value }`
2. `state::update { scope: workflow_run, key: "[RUN_ID]", ops: [{ type: "append", path: "state_keys", value: "[key]" }] }`  
   (append nur wenn Key noch nicht in der Liste – dedupliziert)
3. **Audit-Trace intern schreiben** — die Workflow Engine ruft intern `workflow::trace-write` auf (nicht `state::set`):
   - `event_name: "workflow.state.set"`
   - Attributes: `workflow.state.key`, `workflow.state.value` (**Preview**, s.u.), `workflow.node_uid`, `workflow.run_id`, `iii.function.id`, `workflow.runtime`
   - Die Trace-Engine hat eigene Adapter (OTel Collector, Tempo, File, …) und entscheidet selbst über die Persistenz — kein direkter State-Write

### Value-Preview im Trace

Da Trace-Backends (OTel, Tempo) für große Payloads nicht geeignet sind, wird `workflow.state.value` im Trace **gekürzt**:

| Wert-Typ | Verhalten im Trace |
|---|---|
| `string` | max. 200 Zeichen, danach `…` |
| `number`, `boolean`, `null` | vollständig |
| `object` / `array` | JSON-serialisiert, max. 500 Zeichen, danach `…[truncated]` |

Der vollständige Wert ist immer über `state::get` / den State-Inspector in der UI abrufbar — der Trace dient nur dem Audit-Verlauf, nicht als Datenspeicher.

## Delete-Flow (state-delete)

Wenn `workflow::state-delete { run_id, key }` aufgerufen wird:

1. `state::delete { scope: workflow_run_state, key: "[RUN_ID]:[key]" }`
2. `state::update { scope: workflow_run, key: "[RUN_ID]", ops: [{ type: "remove", path: "state_keys.[key]" }] }`  
   (Eintrag aus dem Array im Run-Record entfernen)
3. **Audit-Trace intern schreiben** — die Workflow Engine ruft intern `workflow::trace-write` auf:
   - `event_name: "workflow.state.delete"`
   - Attributes: `workflow.state.key`, `workflow.node_uid`, `workflow.run_id`, `iii.function.id`, `workflow.runtime`
   - Auch hier: kein State-Write, sondern der Trace-Transport der Engine

## Update-Flow (state-update)

Wenn `workflow::state-update { run_id, key, ops }` aufgerufen wird:

1. `state::update { scope: workflow_run_state, key: "[RUN_ID]:[key]", ops }`
2. Key muss nicht in Registry eingetragen werden, wenn er bereits existiert – optional: prüfen und ggf. hinzufügen
3. **Audit-Trace intern schreiben** — die Workflow Engine ruft intern `workflow::trace-write` auf:
   - `event_name: "workflow.state.update"`
   - Attributes: `workflow.state.key`, `workflow.state.ops` (serialisiert), `workflow.node_uid`, `workflow.run_id`
   - Auch hier: kein State-Write, sondern der Trace-Transport der Engine

## Interner Ablauf von `workflow::state-list`

Die Funktion `workflow::state-list { run_id }` läuft vollständig in der Workflow Engine (Worker) ab:

1. **Registry lesen**  
   `state::get { scope: workflow_run, key: "[RUN_ID]" }` → Run-Record  
   → `run.state_keys: string[]` enthält alle User-Keys, die für diesen Run gesetzt wurden.

2. **Werte parallel abrufen**  
   Für jeden Key aus der Registry:  
   `state::get { scope: workflow_run_state, key: "[RUN_ID]:[key]" }`  
   → parallel, um Latenz zu minimieren.

3. **Response zusammenstellen**  
   `[{ key: "count", value: 3 }, { key: "result", value: {...} }, ...]`  
   Keys, für die `state::get` `null` zurückgibt (bereits gelöscht), werden ausgelassen.

**Wichtig:** Die Registry liegt unter `workflow_run` (Run-Metadaten), nicht unter `workflow_def` (Definition). Die Definition beschreibt die Struktur des Workflows, aber welche Keys tatsächlich während eines Runs gesetzt wurden, ist Run-spezifisch und wird erst zur Laufzeit befüllt. Ein Entwickler kann je nach Eingabe unterschiedliche Keys setzen — das ist zur Definitionszeit nicht bekannt.

## Read-Flow (state-list) – für die UI-API

`GET /api/_workflows/states?run_id=[RUN_ID]`

1. `workflow::state-list { run_id }` aufrufen — gibt `[{ key, value }, ...]` zurück
2. Response: `{ states: [{ key, value }, ...] }`

→ Die interne Funktion übernimmt Registry-Lookup, Key-Mapping und paralleles Fetching. Der Nitro-Server greift nie direkt auf `state::get` oder `state::list` zu.

## Developer Experience (Node.js / Python)

Der Entwickler schreibt:

```ts
await ctx.workflow.state.set('count', 3)
await ctx.workflow.state.get('count')
await ctx.workflow.state.delete('count')
await ctx.workflow.state.list()  // → [{ key: 'count', value: 3 }]
```

Das Key-Mapping (`[RUN_ID]:[key]`) und die Registry-Pflege passieren intern – vollständig transparent für den Entwickler.

## Audit-Prinzip

Alle State-Operationen werden **automatisch durch die workflow engine auditiert** – der Entwickler muss nichts selbst aufrufen.

**Wichtig:** Traces werden **nicht** über `state::set` geschrieben. Die Trace-Infrastruktur hat eigene Adapter (OTel Collector, Tempo, File-Based, …) mit eigener Konfiguration. Traces gehen immer über die internen Engine-Funktionen:

- `workflow::trace-write` — persistenter Trace-Record für die UI-Timeline und konfigurierte Trace-Backends
- `activeSpan.addEvent(...)` — OTel Span-Event für OpenTelemetry-Kompatibilität (nur wenn ein aktiver Span vorhanden)

Die Trace-Events erscheinen automatisch:
- In der **Audit-Timeline** der UI (Filter: "State Events") — über den konfigurierten Trace-Adapter
- In **Tempo/Jaeger** o.ä. — wenn ein OTel-Export-Adapter konfiguriert ist

State-Scope (`workflow_run_state`, `workflow_run`) und Trace-System sind damit vollständig getrennt. Der State speichert Werte und die Key-Registry. Der Trace-Transport speichert den Verlauf.

## Referenz

- iii-state Doku: https://workers.iii.dev/workers/iii-state
- `state::list` akzeptiert nur `scope`, kein Key-Filter
- `state::update` mit `append`-Op für Array-Einträge (Registry)

## Cleanup-Flow (Run-Löschung)

Der interne Cleanup-Mechanismus (der Runs nach einer konfigurierten Retention-Zeit entfernt) muss die Reihenfolge einhalten, da der Run-Record die einzige Referenz auf die State-Keys enthält:

1. **State-Keys lesen** (bevor der Run-Record gelöscht wird)  
   `state::get { scope: workflow_run, key: "[RUN_ID]" }` → `run.state_keys: string[]`

2. **Alle State-Werte löschen**  
   Für jeden Key aus `state_keys`:  
   `state::delete { scope: workflow_run_state, key: "[RUN_ID]:[key]" }`  
   → parallel ausführen

3. **Run-Record löschen**  
   `state::delete { scope: workflow_run, key: "[RUN_ID]" }`  
   → erst wenn Schritt 2 abgeschlossen ist

> Wird der Run-Record zuerst gelöscht, sind die zugehörigen State-Werte in `workflow_run_state` verwaist und können nicht mehr automatisch bereinigt werden (Memory/Storage Leak).