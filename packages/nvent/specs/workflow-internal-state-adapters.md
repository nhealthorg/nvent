# Workflow Internal State Adapters (Redis + File)

Status: Draft (Phase 0)
Datum: 2026-07-28
Owner: workflow-worker

## 1. Ziel

Die interne Workflow-Persistenz des Rust-Workers wird von iii-state entkoppelt, damit kritische Run-Metadaten robuster, performanter und besser kontrollierbar gespeichert werden.

Die Trennung ist bewusst:

- Weiterhin ueber iii: Queue, Stream, Trigger und User-State APIs der Workflow-Funktionen.
- Neu intern im Worker: persistenter Workflow-Kernzustand ueber eigene Adapter fuer Redis und File.

## 2. Scope und Nicht-Scope

### 2.1 Wird ausgelagert (neu ueber Internal Store)

- workflow_def
- workflow_run
- workflow_node_result
- workflow_run_log
- workflow_run_trace

### 2.2 Bleibt bei iii-state

- workflow_run_state

Anmerkung:
workflow_run_state bleibt die API fuer ctx.workflow.state.* (User/Business-State). Schluessel bleiben run-scoped.

### 2.3 Legacy-Sonderkeys werden integriert (kein eigener Scope)

- workflow_run_queue_receipts wird in workflow_run integriert (run-lokales Feld queue_receipts)
- workflow_session_index wird in den Internal Store ueberfuehrt (session_id -> run_id Mapping)
- workflow_idem wird umbenannt zu workflow_idempotency und ebenfalls in den Internal Store ueberfuehrt

Damit entfallen diese Legacy-Scope-Namen als eigenstaendige Persistenzbereiche.

## 3. Architekturprinzipien

1. Harte Verantwortungsgrenze
Internal Store verwaltet nur orchestratorische Datenstrukturen, nie fachliche User-State-Keys.

2. Adapter-first
Ein einheitliches Internal-Store-Interface im Worker, Implementierungen:
- redis
- file

3. Crash-Safety vor Feature-Breite
Schreibpfade muessen atomar und recovery-faehig sein.

4. Skalierung bei Redis, Single-Node bei File
Redis ist die produktive, horizontal skalierbare Variante.
File ist fuer lokal/dev und kleine Single-Instance-Setups.

5. Read/Write-Pfade ohne state::list Vollscan
Globale Vollscans sind zu vermeiden; stattdessen Indexe, Prefix-Strukturen und gerichtete Abfragen.

6. Kein Legacy-Compat-Zwang
Bei der Implementierung muss kein Legacy-Code oder Legacy-Verhalten beibehalten werden. Der Worker darf komplett auf die neue Internal-Store-Logik umprogrammiert werden, solange die fachliche Funktionalitaet der Workflow-API erhalten bleibt.

## 4. Datenmodell (logisch)

### 4.1 workflow_run
- Key: run_id
- Wert: serialisierter WorkflowRunRecord
- Metadaten: version, updated_at, status

### 4.2 workflow_def
- Key: run_id (oder def_key(run_id))
- Wert: WorkflowDef JSON

### 4.3 workflow_node_result
- Key: run_id + node_uid
- Wert: beliebiges JSON result

### 4.4 workflow_run_log
- Key: run_id
- Wert: append-only Liste von WorkflowRunLogRecord

### 4.5 workflow_run_trace
- Key: run_id
- Wert: append-only Liste von WorkflowRunTraceRecord

### 4.6 Integrierte Hilfsdaten (ohne Legacy-Scopes)

- session_index
  - Logik: session_id -> run_id
  - Redis: wf:v1:session:{session_id} = run_id
  - File: session-index/{session_id}.json

- idempotency
  - Neuer Name: workflow_idempotency (statt workflow_idem)
  - Logik: idem_key -> run_id
  - Redis: wf:v1:idempotency:{key} = run_id
  - File: idempotency/{key}.json

- queue_receipts
  - Integration in workflow_run als Feld queue_receipts (Array oder kompaktes Map-Format)
  - Kein separater Top-Level Scope notwendig

## 5. Interface-Entwurf (Worker-intern)

```rust
pub trait WorkflowInternalStateStore: Send + Sync {
    async fn get_run(&self, run_id: &str) -> Result<Option<WorkflowRunRecord>, WorkflowError>;
    async fn put_run(&self, record: &WorkflowRunRecord) -> Result<(), WorkflowError>;
    async fn list_runs(&self) -> Result<Vec<WorkflowRunRecord>, WorkflowError>;
    async fn delete_run(&self, run_id: &str) -> Result<(), WorkflowError>;

    async fn get_def(&self, run_id: &str) -> Result<Option<WorkflowDef>, WorkflowError>;
    async fn put_def(&self, run_id: &str, def: &WorkflowDef) -> Result<(), WorkflowError>;
    async fn delete_def(&self, run_id: &str) -> Result<(), WorkflowError>;

    async fn get_node_result(&self, run_id: &str, node_uid: &str) -> Result<Option<Value>, WorkflowError>;
    async fn put_node_result(&self, run_id: &str, node_uid: &str, value: &Value) -> Result<(), WorkflowError>;
    async fn delete_node_result(&self, run_id: &str, node_uid: &str) -> Result<(), WorkflowError>;

    async fn put_run_log(&self, run_id: &str, entry: &WorkflowRunLogRecord) -> Result<(), WorkflowError>;
    async fn list_run_logs(&self, run_id: &str) -> Result<Vec<WorkflowRunLogRecord>, WorkflowError>;
    async fn delete_run_log_key(&self, run_id: &str, id: &str) -> Result<(), WorkflowError>;
    async fn prune_run_logs_before(&self, run_id: &str, cutoff_unix_ms: i64) -> Result<u64, WorkflowError>;

    async fn put_run_trace(&self, run_id: &str, entry: &WorkflowRunTraceRecord) -> Result<(), WorkflowError>;
    async fn list_run_traces(&self, run_id: &str) -> Result<Vec<WorkflowRunTraceRecord>, WorkflowError>;
    async fn delete_run_trace_key(&self, run_id: &str, id: &str) -> Result<(), WorkflowError>;
    async fn prune_run_traces_before(&self, run_id: &str, cutoff_unix_ms: i64) -> Result<u64, WorkflowError>;
}
```

Hinweis:
- API bleibt bewusst nah an heutigen state.rs-Operationen, damit Migration risikoarm bleibt.
- Spaeter kann eine compare-and-set Variante fuer put_run ergaenzt werden.

## 6. Redis-Design (Production, robust + skalierbar)

### 6.1 Keyspace

Prefix: wf:v1

- wf:v1:run:{run_id} (HASH)
  - data: JSON
  - version: int
  - updated_at: unix_ms
  - status: string
- wf:v1:run:index (ZSET score=updated_at, member=run_id)
- wf:v1:def:{run_id} (STRING JSON)
- wf:v1:result:{run_id}:{node_uid} (STRING JSON)
- wf:v1:log:{run_id} (STREAM)
- wf:v1:trace:{run_id} (STREAM)
- wf:v1:session:{session_id} (STRING run_id)
- wf:v1:idempotency:{key} (STRING run_id)

### 6.2 Schreibverfahren

1. put_run
- Atomar per Lua Script:
  - HSET run hash (data, updated_at, status)
  - HINCRBY version 1
  - ZADD run:index updated_at run_id
- Ziel: kein partieller Zustand zwischen Record und Index.

2. put_def / put_node_result
- SET mit serialisiertem JSON.
- Optional EX fuer technische TTL nur bei expliziter Cleanup-Policy.

2b. session_index / idempotency
- SET fuer direkte Key-Lookups (O(1) Zugriff).
- Optional TTL nur, wenn semantisch erlaubt (idempotency ggf. mit dedizierter Retention).

3. put_run_log / put_run_trace
- XADD in run-spezifische Streams.
- Optionales Trim via MAXLEN ~ N (konfigurierbar).

4. queue_receipts
- Update innerhalb workflow_run (atomar zusammen mit run-write oder via gezieltem Feld-Update).

### 6.3 Leseverfahren

- list_runs: ZREVRANGE run:index + HMGET/HGETALL je run (gebatcht/Pipeline).
- list_run_logs/run_traces: XRANGE pro run-stream.

### 6.4 Loeschen und Prune

- delete_run:
  - DEL run hash
  - ZREM run:index
  - DEL def key
  - SCAN + DEL result keys mit Prefix result:{run_id}:
  - DEL log stream
  - DEL trace stream
  - DEL session/index keys, die auf den run zeigen (nur wenn vorhanden)
  - queue_receipts fallen mit run-Dokument automatisch weg
- prune_run_logs_before / prune_run_traces_before:
  - XTRIM MINID ~ {cutoff}-0 (Redis >= 7) oder XRANGE+XDEL fallback.

### 6.5 Concurrency und Korrektheit

- Primarannahme bleibt Single-Writer-per-run (wie heute, Locking im Worker).
- Redis-Schreibpfade trotzdem atomar, damit Multi-Writer-Fehlkonfiguration keine stillen Korruptionen erzeugt.
- Optional Phase 2: Fencing Token / owner epoch im run hash.

## 7. File-Design (Dev/Single-Instance)

### 7.1 Layout

Basisverzeichnis: .data/workflow-store

- runs/{run_id}.json
- defs/{run_id}.json
- results/{run_id}/{node_uid}.json
- logs/{run_id}.ndjson
- traces/{run_id}.ndjson
- indices/runs.json
- session-index/{session_id}.json
- idempotency/{key}.json

### 7.2 Schreibsicherheit

- JSON-Dokumente via write-temp + fsync + atomic rename.
- NDJSON append fuer logs/traces.
- runs.json bei jedem put_run atomar aktualisieren.

### 7.3 Grenzen

- Keine horizontale Skalierung.
- Kein Multi-Process-Writer Support als Ziel.
- Fuer Produktivbetrieb nur redis empfohlen.

## 8. Interaktion mit iii-state

workflow_run_state bleibt unveraendert ueber iii-state:

- workflow::state-set/get/delete/list schreiben/lesen weiterhin scope workflow_run_state.
- run key registry (state key map) bleibt im run record, aber der run record liegt nach Migration im Internal Store.
- Damit entfaellt der Vollscan von iii-state fuer interne Worker-Daten.

## 9. Migrationsplan

### Phase 0: Spec und Contracts
- Diese Spezifikation finalisieren.
- Trait/API in Rust definieren.

### Phase 1: Infrastruktur
- Internal-store module erstellen (trait + errors + config).
- Redis Adapter implementieren.
- File Adapter implementieren.
- Adapter Factory + runtime wiring.

### Phase 2: state.rs entkoppeln
- get_run/put_run/get_def/put_def/node_result/log/trace auf Internal Store umstellen.
- workflow_run_state Aufrufe explizit bei iii belassen.
- put/get fuer session_index und idempotency auf Internal Store umstellen.
- queue_receipts in workflow_run integrieren (separater Scope entfaellt).
- Legacy-Pfade, Legacy-Scope-Namen und Rueckwaertskompatibilitaets-Branches werden nicht mitgeschleppt; Zielzustand ist eine saubere Neulogik.

### Phase 3: Tests und Hardening
- Contract-Tests adapter-agnostisch.
- Redis Integrationstests (parallel updates, prune, cleanup).
- Crash-Recovery Tests fuer File Adapter.

### Phase 4: Optional
- Feinoptimierung: queue_receipts Auslagerung in separates run-subdocument nur falls Write-Hotspot auftritt.

## 10. Testkriterien (Minimum)

1. Konsistenz
- put_run + list_runs liefert denselben Datensatz inkl. status/updated_at.

2. Cleanup
- delete_run entfernt run/def/results/logs/traces vollstaendig.

3. Prune
- prune_run_logs_before und prune_run_traces_before entfernen nur Daten < cutoff.

4. Parallelitaet
- 1000 parallele log writes auf einen run verlieren keine Eintraege.

5. Kompatibilitaet
- workflow::state-* (User-State) bleibt unveraendert funktional.

## 11. Entscheidungen (festgelegt)

1. put_run bekommt kurzfristig expected_version fuer echtes CAS.
2. logs/traces werden in Redis zusaetzlich ueber globale Zeitindexe abfragbar gemacht.
3. File-Adapter bleibt vorerst bei NDJSON; SQLite bleibt explizit ein spaeteres Upgrade.
4. idempotency hat default-maessig eine TTL (konfigurierbar, initial 30 Tage).

### 11.1 Konkrete Defaults

- idempotency_ttl_ms default: 2_592_000_000 (30 Tage)
- redis_global_log_trace_index: aktiviert
- put_run CAS: expected_version erforderlich fuer compare-and-set Pfad; ohne expected_version nur fuer explizite bootstrap/internals erlaubt

## 12. Bezug zur alten TypeScript-Implementierung

Die erfolgreiche alte TS-Architektur (stream + index + kv) bleibt konzeptionell erhalten:

- kv-artig: run, def, node_result
- stream-artig: run_log, run_trace
- index-artig: run listing und cleanup-orientierte Selektion

Neu ist nur der Ort der Implementierung: Rust Worker intern statt vollstaendig ueber iii-state.