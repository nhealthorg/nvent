# Logs und Traces in den Workflow Worker verlagern

## Zielbild
Logs und Traces sollen nicht mehr primär aus iii-observability gelesen werden, sondern als eigenes Subsystem im Rust Workflow Worker leben.

Das System soll folgende Eigenschaften haben:

1. Run-zentrierte Speicherung über run_id
2. Einheitliche API aus dem Workflow Worker
3. Retention und Löschung im Worker, konfigurierbar
4. Adapter-fähig für externe Backends
5. Laufzeit-kompatibel für Node und Python Wrapper

## Externe API des Workflow Workers
Es gibt sechs öffentliche Funktionen:

1. workflow::log-write
2. workflow::log-read
3. workflow::log-delete
4. workflow::trace-write
5. workflow::trace-read
6. workflow::trace-delete

Grundsatz:
Alle Requests sind run-zentriert. Primärer Schlüssel ist run_id, optionale Filter sind node_uid, function_id, level und Zeitbereich.

## State Scopes
Im Minimal-Setup werden Logs und Traces in iii-state persistiert.

Verwendete Scopes:

1. workflow_run
2. workflow_def
3. workflow_node_result
4. workflow_run_log
5. workflow_run_trace

Scopes, die entfernt werden sollen:

1. workflow_trace_index
2. workflow_def_runtime

Falls Daten aus deprecated Scopes nötig sind, müssen sie in einen der fünf Ziel-Scopes migriert werden.

## Datenmodell

### workflow_run_log
Empfohlenes Record-Modell pro Eintrag:

1. id
2. run_id
3. node_uid optional
4. function_id optional
5. runtime optional
6. level
7. message
8. ts_unix_ms
9. data optional

Key-Strategie für state:
run_id plus log_id als zusammengesetzter Key.

### workflow_run_trace
Empfohlenes Record-Modell pro Eintrag:

1. id
2. run_id
3. node_uid optional
4. function_id optional
5. runtime optional
6. event_name
7. ts_unix_ms
8. attributes optional
9. trace_id optional
10. span_id optional

Key-Strategie für state:
run_id plus trace_event_id als zusammengesetzter Key.

Hinweis:
Das ist ein Event-Modell für die Timeline. Es ist kein vollständiger OTel-Span-Graph-Ersatz. Adapter können intern dennoch auf OTel-Spans mappen.

## Wrapper-Verhalten Node und Python

### Workflow-Kontext
Wenn eine Funktion innerhalb eines Workflows läuft:

1. ctx.logger schreibt in workflow::log-write
2. Wrapper schreibt Systemevents in workflow::trace-write
3. Wrapper erhält run-scoped helper für state und stream

Wenn eine Funktion normal außerhalb eines Workflows läuft:

1. bestehendes iii-Logging bleibt unverändert
2. scope muss wie bisher explizit angegeben werden

### Systemevents aus Wrappern
Mindestens folgende Events sollen geschrieben werden:

1. workflow.node.started
2. workflow.node.completed
3. workflow.node.failed
4. workflow.node.retry optional in Phase 2

## Problem: Race Condition beim aktuellen Write-Pattern

### Aktueller Code (state.rs)

`put_run_log` und `put_run_trace` verwenden ein **Read-Modify-Write**-Pattern:

```rust
// 1. Bucket lesen
let mut bucket = get_run_log_bucket(iii, &entry.run_id).await?
    .unwrap_or_else(|| WorkflowRunLogBucket { ... });

// 2. Lokal modifizieren
bucket.logs.push(entry.clone());

// 3. Komplett zurückschreiben
state_set(iii, SCOPE_RUN_LOG, &entry.run_id, serde_json::to_value(bucket)?).await
```

### Das Problem

`state::set` ist ein **unconditional overwrite** – es gibt kein Compare-and-Set.

Kommen zwei Events **gleichzeitig** (z.B. `workflow.node.started` und ein Log-Eintrag aus demselben Node-Run), passiert folgendes:

```
Worker A:  read(bucket=[])   →  push(log_1)  →  write(bucket=[log_1])
Worker B:  read(bucket=[])   →  push(log_2)  →  write(bucket=[log_2])
                                                  ^--- überschreibt log_1!
```

**Ergebnis:** `log_1` ist verloren. Nur `log_2` ist gespeichert.

Da der Workflow Worker normalerweise single-writer-per-run ist (Lock), tritt das im Normalfall nicht auf. Aber:
- Log-Writes aus Node.js/Python Runtimes laufen **außerhalb des Locks**
- Trace-Writes aus `emitWorkflowTraceEvent` in node.ts laufen parallel
- Bei Retries können mehrere Instanzen kurzzeitig gleichzeitig schreiben

### Lösung: `state::update` mit atomarem `append`-Op

iii-state bietet `state::update` mit Array-Operationen, die **atomar** auf Serverseite ausgeführt werden:

```json
{
  "function_id": "state::update",
  "payload": {
    "scope": "workflow_run_log",
    "key": "[RUN_ID]",
    "ops": [{ "type": "append", "path": "logs", "value": { ...log_entry... } }]
  }
}
```

Damit entfällt das Read-Modify-Write komplett. Der Server führt den `append` atomar aus:

```
Worker A:  update(append log_1)  →  server: logs=[log_1]
Worker B:  update(append log_2)  →  server: logs=[log_1, log_2]  ✓
```

Kein Lost Update, keine Race Condition — unabhängig von der Anzahl gleichzeitiger Writer.

### Verfügbare atomare Ops (iii-state v0.21.6)

| Op | Beschreibung |
|---|---|
| `append` | Push ein Element in ein Array oder String konkatenieren |
| `set` | Feld setzen oder Root-Wert ersetzen |
| `merge` | Shallow-merge eines Objekts |
| `increment` | Numerisches Feld erhöhen |
| `decrement` | Numerisches Feld verringern |
| `remove` | Feld aus Objekt entfernen |

### Geplante Umstellung

- `put_run_log` → `state::update` mit `append` auf `logs`-Array
- `put_run_trace` → `state::update` mit `append` auf `traces`-Array
- Initial-Erstellung (erster Write) → `state::set` mit leerem Bucket, dann `update`  
  **oder** direkt `update` mit `merge`-Op, falls der Key noch nicht existiert (muss getestet werden)
- Read (`list_run_logs`, `list_run_traces`) → unverändert via `state::get` + Bucket-Deserialisierung


Funktionen sollen nicht mehr automatisch für Workflow-Queue registriert werden.

Neue Zielkonfiguration in defineFunction:

1. workflow gleich true für Standardverhalten
2. workflow als Objekt für Queue- und Retry-Optionen

Beispiele:

1. workflow gleich true
2. workflow.queue

Queue-Tuning (retries, concurrency, fifo/message_group_field) wird zentral in
iii queue_configs definiert, nicht mehr pro Funktion über workflow.*.

Nur Funktionen mit workflow-Konfiguration sind workflow-ausführbar. Zusätzliche iii-Trigger bleiben erlaubt.

## Read-Pfad für UI
Die UI soll nur noch über workflow::trace-read und workflow::log-read lesen.

Timeline-Zusammenbau:

1. trace-read liefert Systemevents
2. log-read liefert Benutzerlogs
3. UI merged beide Streams nach Zeitstempel

Damit entfällt die fragile Abhängigkeit zu engine::traces::list und engine::logs::list für die Workflow-Timeline.

## Retention und interne Löschung
Retention wird im Workflow Worker konfiguriert.

Parameter:

1. logs_retention_days
2. traces_retention_days
3. cleanup_interval_seconds

Interner Mechanismus:

1. geplanter Sweep löscht alte Einträge aus workflow_run_log
2. geplanter Sweep löscht alte Einträge aus workflow_run_trace
3. optional harte Löschung pro Run über log-delete und trace-delete

## Adapter-Architektur
Der Worker bekommt ein internes Adapter-Interface:

1. write_log
2. read_log
3. delete_log
4. write_trace
5. read_trace
6. delete_trace

Default-Adapter:

1. StateAdapter auf iii-state

Spätere Adapter:

1. LokiAdapter für Logs
2. TempoAdapter für Traces
3. HybridAdapter für beide Richtungen

Wichtig:
Adapter müssen nicht nur schreiben, sondern auch lesen, damit die Worker-API immer konsistent bleibt.

## Migrationsplan

### Phase 1
Neue sechs APIs im Workflow Worker bereitstellen, StateAdapter aktivieren, UI von workflow::timeline schrittweise auf log-read und trace-read umstellen.

### Phase 2
Wrapper auf workflow::log-write und workflow::trace-write umstellen, automatische Queue-Registrierung entfernen, workflow-Konfiguration aktivieren.

### Phase 3
Deprecated Scopes workflow_trace_index und workflow_def_runtime entfernen, Daten migrieren, Cleanup standardmäßig aktivieren.

### Phase 4
Adapter-Schnittstelle stabilisieren und externe Adapter integrieren.

## Akzeptanzkriterien

1. Für einen Run mit nodejs und python sind Logs und Traces vollständig über run_id lesbar
2. Timeline zeigt Systemevents und Benutzerlogs konsistent an
3. Nach Retention-Ablauf sind alte Einträge entfernt
4. Keine Abhängigkeit mehr auf engine::traces::list und engine::logs::list für Workflow-Timeline
5. Alle Tests für Write, Read, Delete und Cleanup laufen stabil