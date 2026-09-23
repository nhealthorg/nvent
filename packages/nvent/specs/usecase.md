# Cohort Extraction Pipeline — Spezifikation

**Status:** V2-Entwurf - kanonische Pipeline-Semantik und nvent-Orchestrierung festgelegt  
**Zweck:** Sequenzielle, komponierbare Extraktion von Cohort-Parametern und Baselines  
**Runtime:** nvent / iii Functions und Workflows  
**Bezug:** `specs/cohort_builder.md`, `specs/LLM_EXTRACTION/cohort_builder_operation_test_spec.md`

## 1. Ziel

Eine Extraction Strategy darf nicht nur ein einzelner Fallback-Versuch sein. In der Praxis muss ein Parameter aus mehreren Verarbeitungsschritten entstehen koennen, zum Beispiel:

```text
Records laden
  -> Records filtern
  -> Lookup oder Feldwert lesen
  -> Wert transformieren
  -> Werte aggregieren
  -> Ergebnis validieren
  -> kanonisches Resultat mit Provenance erzeugen
```

Die gleiche Pipeline muss fuer folgende Faelle verwendet werden:

- kompletter Cohort-Run ueber viele Patienten,
- Testlauf fuer einen Patienten und einen Parameter,
- Baseline-Test,
- spaetere Re-Evaluation eines einzelnen Ergebnisses.

Bei jedem Patientenlauf wird eine konfigurierte Baselinepipeline vor der ersten Parameterpipeline ausgefuehrt. Das gilt identisch fuer vollstaendige Cohort-Runs, Parameter-Tests und Baseline-Tests. Alle Parameter desselben Patienten verwenden danach denselben aufgeloesten Baseline-Kontext; die Baseline wird nicht einmal pro Parameter neu ermittelt.

Es darf keine zweite, vereinfachte Testlogik geben. Der Test ist lediglich eine andere Ausfuehrungsart derselben Pipeline.

## 2. Grundsaetze

- **Linear und explizit:** Jeder Verarbeitungsschritt steht als eigener Step in einer geordneten Liste.
- **Komponierbar:** Jeder Step konsumiert ein definiertes Artefakt und erzeugt ein definiertes Artefakt.
- **Deterministisch:** Gleicher Input, gleiche Konfiguration und gleiche Datenversion ergeben dasselbe Resultat.
- **Auditierbar:** Jeder Step schreibt Status, Input-Referenzen, Output, Dauer, Warnings und Fehler in den Trace.
- **Read-only gegen Quelldaten:** Pipeline-Steps veraendern niemals `records` oder Importdaten.
- **Einheitliche Runtime:** Run und Test rufen dieselben iii Functions auf.
- **Ein Zielmodell:** Die Pipeline ist die einzige kanonische Definition und Runtime-Quelle.
- **Projektgebunden:** Jeder Zugriff auf Records und Patienten bleibt auf den aktiven `project_id`-Kontext beschraenkt.
- **Baseline zuerst:** Die Baseline ist ein eigener, gemeinsamer Pipeline-Lauf pro Patient und steht vor allen Parameterpipelines.

## 3. Fachliches Modell

### 3.1 Pipeline

Eine Pipeline ist eine versionierte Liste von Steps:

```json
{
  "schema_version": "1.0",
  "pipeline_version": 3,
  "input": {
    "subject": "patient",
    "records": "project_patient_records",
    "target": {
      "kind": "parameter",
      "id": "parameter-1",
      "output_type": "continuous"
    }
  },
  "steps": [
    {
      "id": "select-procedures",
      "type": "select",
      "config": {
        "source": "prozeduren.txt",
        "where": { "OPCode": { "in": ["8-836.0C", "8-836.0S"] } }
      }
    },
    {
      "id": "extract-date",
      "type": "extract",
      "config": { "field": "Beginndatum" }
    },
    {
      "id": "transform-date",
      "type": "transform",
      "config": { "operation": "date_shift", "shift_days": -30 }
    },
    {
      "id": "choose-first",
      "type": "aggregate",
      "config": { "method": "first", "order_by": "record_date" }
    },
    {
      "id": "validate-date",
      "type": "validate",
      "config": { "value_type": "date", "required": true }
    }
  ]
}
```

`steps` werden immer von oben nach unten ausgefuehrt. Ein Step darf nur auf Outputs vorheriger Steps oder auf den initialen Patient-/Record-Input zugreifen.

### 3.2 Step-Typen

| Typ | Zweck | Typischer Input | Typischer Output |
|---|---|---|---|
| `select` | Records nach Source, Datum oder Bedingungen einschraenken | Record-Set | Record-Set |
| `join` | Records oder Felder aus mehreren Inputs verbinden | mehrere Record-Sets | Record-Set / Objekt |
| `merge` | Werte/Felder aus mehreren Records zu einem Objekt zusammenfuehren | Record-Set | Objekt / Kandidat |
| `lookup` | Match-Feld innerhalb des aktuellen Record-Sets pruefen und ein Ergebnisfeld lesen | Record-Set | Kandidaten |
| `extract` | Ein benanntes Feld aus dem aktuellen Record-Set oder Objekt lesen | Record-Set / Objekt | Kandidaten |
| `transform` | Wert normalisieren oder umformen | Wert / Kandidaten | Wert / Kandidaten |
| `aggregate` | mehrere Werte zu einem Wert reduzieren | Kandidaten | Wert / Kandidat |
| `validate` | Typ, Bereich, Pflichtwert oder erlaubte Werte pruefen | Wert | validierter Wert |
| `fallback` | nicht als einzelner Step; wird ueber `mode: "fallback"` und vollstaendige Branches modelliert | mehrere Pipeline-Zweige | erster gueltiger Output |
| `custom_function` | reservierter Erweiterungspunkt fuer eine spaetere Version | definiertes JSON | definiertes JSON |
| `llm_extract` | LLM/Agent-Extraktion aus Textkandidaten | Text/Evidence | Wert + Evidence |

Nicht jeder Step muss alle Felder verwenden. Jeder Step muss aber ein standardisiertes Step-Ergebnis liefern. `fallback` ist kein einzelner Step, sondern ein Pipeline-Modus mit vollstaendigen Branches. Die Step-Typen und der Fallback-Modus sind unabhaengig davon, ob die Pipeline eine Baseline oder einen Parameter extrahiert.

### 3.2.1 Semantische Trennung der Steps

Die kanonische Pipeline kennt keinen `direct_field`-Step. Eingaben mit `direct_field` sind ungueltige Legacy-Konfigurationen und werden vom Schema abgelehnt. Es gibt keine automatische Alias-Aufloesung und keine Migration zur Laufzeit.

Die Verantwortlichkeiten sind strikt getrennt:

- `select` entscheidet, **welche Records** weiterverarbeitet werden. Nur dieser Step waehlt eine `source` aus.
- `extract` liest **ein benanntes Feld** aus dem aktuellen Record- oder Objekt-Artefakt. Er besitzt keine eigene Source-Auswahl und keine Vorkommensregel.
- `lookup` prueft **eine Bedingung innerhalb der aktuellen Records** und liest bei einem Treffer ein Ergebnisfeld. Er besitzt keine unabhaengige Source-Auswahl. Eine andere Source muss vorher mit `select` oder `join` in den Kontext gebracht werden.
- `aggregate` entscheidet, **welcher Wert aus mehreren Candidates** weitergegeben wird. `first` und `last` beziehen sich auf eine explizite Sortierung, standardmaessig auf `record_date`, nicht auf die zufaellige Reihenfolge eines Arrays.
- `transform` veraendert bereits erzeugte Werte oder Candidates und sucht keine Records.
- `validate` entscheidet, ob ein Wert fachlich gueltig ist, waehlt aber nicht stillschweigend einen anderen Record aus.

Eine Auswahl wie „letztes Vorkommen“ gehoert daher zu `aggregate`, nicht zu `extract`, `lookup` oder `direct_field`. Eine Pipeline, die mehrere Records lesen kann, muss die Reduktion explizit modellieren:

```text
select -> extract/lookup -> aggregate(last) -> validate
```

Ein `select`-Step verwendet immer das aktuelle `record_set`-Artefakt. Beim ersten Step ist dieses Artefakt der vollstaendige Record-Kontext des Patienten; spaetere `select`-Steps schraenken den bisherigen Record-Satz weiter ein und setzen ihn nicht auf alle Patienten-Records zurueck.

### 3.3 Gemeinsamer Extraction-Kontext fuer Baseline und Parameter

Baseline und Parameter werden durch denselben Pipeline-Vertrag beschrieben und ausgefuehrt. Der Kontext enthaelt mindestens:

```json
{
  "project_id": "project-1",
  "patient_id": "patient-123",
  "target": {
    "kind": "baseline",
    "id": "cohort-baseline",
    "output_type": "date"
  },
  "baseline": null,
  "records": "project_patient_records"
}
```

`target.kind` ist entweder `baseline` oder `parameter`:

- `baseline`: Die Pipeline erzeugt einen validierten zeitlichen Referenzpunkt. Ihr kanonischer Output ist ein Datum mit Provenance.
- `parameter`: Die Pipeline erzeugt den konfigurierten fachlichen Wert (`binary`, `categorical`, `continuous` oder `object`). Falls eine Baseline vorhanden ist, wird sie als Input-Kontext an die Parameterpipeline uebergeben.

Die Pipeline-Engine kennt keine separate Baseline-Evaluationslogik. Sie fuehrt fuer beide Ziele dieselben Steps, Artefakte, Trace-Regeln, Fehlerbehandlung und nvent-Aufrufe aus. Unterschiede werden ausschliesslich durch `target.output_type`, `target.schema` und explizite Policies modelliert.

Eine Baselinepipeline darf deshalb alle normalen Steps verwenden, zum Beispiel:

```text
select -> extract -> transform(date_shift) -> aggregate(first) -> validate(date)
```

Eine Parameterpipeline kann die aufgeloeste Baseline aus dem Kontext nutzen:

```text
select -> extract -> validate(number)
```

Dabei ist die zeitliche Auswahl (`nearest`, `nearest_before`, `nearest_after`, `window`) entweder eine explizite `baseline_policy` oder ein eigener Pipeline-Step. Eine `baseline_policy` wird auf den bereits durch `select`/`join` fachlich eingegrenzten Record-Kontext angewendet, bevor `extract`/`lookup` Candidates erzeugen. Sie ist kein versteckter Sonderpfad im Evaluator.

### 3.4 Transformationen im Datenfluss

Transformationen sind normale Pipeline-Steps, werden in V1 aber nur auf Werte oder Candidates angewendet. Ein `transform`-Step darf deshalb nicht direkt auf einem `record_set` starten. Die zulaessigen V1-Muster sind:

```text
select -> extract -> transform -> aggregate -> validate
select -> lookup -> transform -> aggregate -> validate
select -> merge -> extract -> transform -> validate
extract -> aggregate -> transform -> validate
```

Eine Transformation vor der Feldextraktion ist nur moeglich, wenn ein eigener Step das Record-Set zuerst in ein passendes Objekt oder Candidate-Set ueberfuehrt. Ein impliziter Zugriff auf Record-Felder durch `transform` ist nicht erlaubt.

Die UI darf Transformationen nicht mehr ausschliesslich als eigenstaendige Fallback-Strategie behandeln. Sie muessen als normale Pipeline-Steps nach einem passenden Wert-/Candidate-Step einfuegbar sein.

Beispiele:

- `select -> merge -> extract`: mehrere Record-Felder zu einem zusammengesetzten Text verbinden.
- `extract -> transform(parse_number) -> transform(unit_convert) -> aggregate(mean)`: numerische Messwerte normalisieren und mitteln.
- `select -> extract(date) -> transform(date_shift) -> validate(date)`: ein Ereignisdatum als verschobene Baseline verwenden.
- `select -> extract(code) -> transform(map) -> validate(categorical)`: Codes in fachliche Kategorien ueberfuehren, sobald eine versionierte Map-Transformation vorhanden ist.

## 4. Konfigurationsschema

### 4.1 Pipeline-Konfiguration pro Parameter

`cohort_parameters.extraction_pipeline` ist die verbindliche kanonische Definition:

```json
{
  "schema_version": "1.0",
  "pipeline_version": 1,
  "mode": "sequential",
  "target": {
    "kind": "parameter",
    "id": "parameter-1",
    "output_type": "continuous"
  },
  "steps": [
    {
      "id": "records",
      "type": "select",
      "config": { "source": "labor.csv", "date_range": "all" },
      "on_error": "continue"
    },
    {
      "id": "value",
      "type": "extract",
      "config": { "field": "HbA1c", "value_type": "number" },
      "on_error": "continue"
    },
    {
      "id": "number",
      "type": "transform",
      "config": { "operation": "parse_number" },
      "on_error": "fail"
    },
    {
      "id": "result",
      "type": "validate",
      "config": { "value_type": "number", "min": 0, "max": 100 },
      "on_error": "fail"
    }
  ]
}
```

Alte Parameterformate mit `extraction_logic`, `extraction_strategies` oder `direct_field` sind keine gueltige Pipeline-Quelle. APIs, Editor, Test und Runner muessen solche Konfigurationen ablehnen und duerfen sie nicht automatisch in eine Pipeline umwandeln. Eine Umstellung erfolgt ausschliesslich durch eine explizite Neuanlage oder ein bewusst ausgefuehrtes, separates Migrationswerkzeug ausserhalb der Runtime.

`mode` ist in V1:

- `sequential`: jeder Step verarbeitet den Output des vorherigen Steps.
- `fallback`: mehrere gleichartige Zweige werden priorisiert versucht; der erste gueltige Zweig gewinnt.

Ein `fallback` muss intern aus vollstaendigen Teilpipelines bestehen. Dadurch kann auch ein Fallback mehrere Schritte enthalten:

```json
{
  "mode": "fallback",
  "branches": [
    {
      "id": "structured-lab",
      "priority": 10,
      "steps": [
        { "type": "select", "config": { "source": "labor.csv" } },
        { "type": "extract", "config": { "field": "HbA1c" } },
        { "type": "transform", "config": { "operation": "parse_number" } }
      ]
    },
    {
      "id": "report-text",
      "priority": 20,
      "steps": [
        { "type": "select", "config": { "source": "arztbriefe.txt" } },
        { "type": "llm_extract", "config": { "prompt_ref": "hba1c-v1" } },
        { "type": "validate", "config": { "value_type": "number" } }
      ]
    }
  ]
}
```

Fuer `equals` gilt: Zuerst wird auf exakte String-Gleichheit geprueft. Sind beide Operanden endliche Zahlen, gilt alternativ numerische Gleichheit. Dadurch matcht beispielsweise die konfigurierte Kennung `0000000082` auch einen importierten Wert `82`, wenn der generische Importer fuehrende Nullen als Zahl normalisiert hat. `contains` bleibt ein case-insensitiver Stringvergleich; es findet keine numerische Teilstring-Suche statt.

### 4.2 Step-Vertrag

Jeder Step verwendet mindestens:

```json
{
  "id": "stable-step-id",
  "type": "extract",
  "version": "1.0",
  "config": {},
  "enabled": true,
  "on_error": "fail"
}
```

Moegliche `on_error`-Werte:

- `fail`: Pipeline endet mit Fehler.
- `continue`: Step wird als fehlgeschlagen protokolliert; der naechste Step darf mit dem letzten gueltigen Artefakt fortfahren.
- `skip_branch`: nur den aktuellen Fallback-Zweig abbrechen.

Unbekannte Step-Typen oder ungueltige Konfigurationen sind immer ein Konfigurationsfehler und duerfen nicht still uebersprungen werden.

Die kanonischen Konfigurationen sind fachlich getrennt:

```json
{
  "type": "select",
  "config": {
    "source": "labor.csv",
    "where": { "Code": { "equals": "HbA1c" } }
  }
}
```

```json
{
  "type": "extract",
  "config": { "field": "Messwert" }
}
```

```json
{
  "type": "lookup",
  "config": {
    "match_field": "Leistungstext",
    "operator": "equals",
    "equals": "HbA1c (NGSP)",
    "value_field": "Messwert"
  }
}
```

```json
{
  "type": "aggregate",
  "config": { "method": "last", "order_by": "record_date" }
}
```

`source` darf nicht in `extract`, `lookup`, `transform`, `aggregate` oder `validate` verwendet werden. `occurrence` ist kein kanonisches Step-Feld; die Auswahl des ersten oder letzten Kandidaten wird ausschliesslich durch `aggregate.method` und `aggregate.order_by` beschrieben.

### 4.3 Pipeline als einziges Konfigurationsmodell

Neue und bestehende Parameter werden direkt als `extraction_pipeline` gespeichert. Es gibt kein paralleles Strategienmodell und keine Konvertierung zur Laufzeit. Die Pipeline-Definition ist die alleinige Quelle fuer Editor, Test, Run und Re-Evaluation.

Baselinepipelines werden im selben Format gespeichert. Fuer die Cohort wird die Baselinepipeline als `cohorts.baseline_pipeline` definiert; `target.kind` muss `baseline` und `target.output_type` muss `date` sein. Parameterpipelines liegen in `cohort_parameters.extraction_pipeline`; `target.kind` muss `parameter` sein.

### 4.3.1 Artefaktvertraege und Step-Komposition

Die Reihenfolge der Steps bestimmt den Datenfluss. Ein Step darf keine eigene, unabhaengige Source-Auswahl voraussetzen, wenn er auf dem Artefakt des vorherigen Steps arbeitet:

| Step | Erlaubter Input | Output |
|---|---|---|
| `select` | initialer Record-Kontext oder `record_set` | `record_set` |
| `join` | `record_set` plus explizite Join-Konfiguration | `record_set` |
| `merge` | `record_set` | `object` oder `candidate_set` |
| `extract` | `record_set` oder `object` | `candidate_set` |
| `transform` | `value`, `candidate_set` oder `validated_value` | `candidate_set` |
| `aggregate` | `candidate_set` | `value` |
| `validate` | `value`, `candidate_set` oder `validated_value` | `validated_value` |

`source` gehoert ausschliesslich zu `select` und den beiden Seiten eines expliziten `join`. `extract` besitzt nur eine Feldkonfiguration und `lookup` nur Match-/Ergebnisfeld-Konfigurationen fuer das aktuelle Record-Set. `transform` verarbeitet ausschliesslich die Werte des vorherigen Artefakts. `lookup` ist fuer die bedingte Extraktion aus derselben Record-Zeile zustaendig: Ein Match-Feld wird geprueft und ein Ergebnisfeld als Candidate ausgegeben. `aggregate` reduziert ausschliesslich ein bereits erzeugtes Candidate-Set mit `method` (`first`, `last`, `median`, `mean`, `min`, `max`) und einer expliziten Sortierung.

So kann beispielsweise `select(source=labor.csv) -> lookup(match_field=Leistungstext, equals=HbA1c (NGSP), value_field=Messwert) -> aggregate(last, order_by=record_date) -> validate` umgesetzt werden. Die Auswahl der Records, die Auswahl des Feldes und die Reduktion mehrerer Werte bleiben damit getrennt.

Ein `join` darf mehrere Ergebnisse erzeugen. Die nachfolgende Pipeline muss dann explizit festlegen, wie daraus ein Wert entsteht, beispielsweise `join -> extract -> aggregate -> validate` oder `join -> merge -> extract -> validate`. Inkompatible Uebergaenge wie `record_set -> transform` oder `record_set -> aggregate` sind Laufzeitfehler `STEP_INPUT_TYPE_MISMATCH`.

Der `validate`-Step verwendet eine typabhaengige Konfiguration. Numerische Werte koennen ueber `min`/`max`, Datumswerte ueber `min_date`/`max_date`, Texte ueber `min_length`/`max_length` und kategorische oder binaere Werte ueber `allowed` eingeschraenkt werden. `required` gilt fuer alle Typen.

### 4.4 LLM- und Agent-Steps

`llm_extract` ist kein externer Sonderpfad und keine abschliessende Validierung. Der Step ruft ueber die nvent-Workflow-/Agent-Infrastruktur ein konfiguriertes Modell auf und erzeugt ein normales Artefakt, das anschliessend durch gewoehnliche Pipeline-Steps verarbeitet wird:

```text
select(text)
  -> merge(prompt_input)
  -> llm_extract(agent_call)
  -> transform(parse/normalize)
  -> aggregate(optional)
  -> validate(schema/type/range)
```

Der LLM-Step muss mindestens speichern:

- `agent_name` bzw. Agent-Referenz,
- Modell-/Prompt-Version,
- strukturierte Eingabe und erwartetes Antwortschema,
- rohe Agent-Antwort nach den geltenden Datenschutzregeln,
- Evidence/Offsets, sofern vorhanden,
- Token-/Kosten-/Laufzeitmetadaten,
- die unveraenderte Antwort als Step-Artefakt fuer nachfolgende Validierung.

Die fachliche Gueltigkeit wird niemals allein aus der LLM-Antwort abgeleitet. Ein `llm_extract`-Step mit syntaktisch gueltiger Antwort kann danach durch `validate` als fachlich ungueltig markiert werden. Ein Agent-Fehler, ein Schemafehler und ein Validierungsfehler bleiben im Trace unterscheidbar.

### 4.5 Join-Semantik in V1

`join` verbindet in V1 ausschliesslich Record-Sets desselben Patienten innerhalb desselben Projekts. Die Join-Konfiguration muss den Join-Schluessel, die Kardinalitaet (`one_to_one`, `one_to_many` oder `many_to_one`) und das Verhalten bei fehlenden bzw. mehrfachen Treffern festlegen.

Ein Join mit einer projektweiten Lookup-Tabelle ist in V1 nicht vorgesehen. Solche Tabellen koennen spaeter ergaenzt werden, benoetigen aber eigene Regeln fuer Berechtigung, Schluessel, Versionierung, Kardinalitaet und Datenabfluss. Ohne explizite Join-Konfiguration darf kein impliziter Cross-Patient- oder Cross-Project-Join stattfinden.

### 4.6 Transformations- und Validierungsbibliotheken

Fuer strukturierte Schema-, Typ- und Fachvalidierung wird `zod` verwendet; die Bibliothek ist bereits Bestandteil des Projekts. Pipeline-Steps duerfen keine eigene parallele Schema-DSL einfuehren.

Fuer Datums- und Zeitintervalloperationen wird `date-fns` als verbindliche Bibliothek vorgeschlagen. Operationen wie `date_shift`, `differenceInDays`, Fenstergrenzen und chronologische Sortierung werden damit implementiert. Falls `date-fns` noch nicht in den Runtime-Dependencies vorhanden ist, wird es als gezielte Dependency ergaenzt. Zeitzonen werden explizit konfiguriert; implizite Server-Zeitzonen sind nicht erlaubt.

Zahlen werden fuer normale Messwerte mit sicheren JavaScript-Zahlen verarbeitet. Fuer Einheiten wird zunaechst eine versionierte, getestete Conversion-Registry fuer die tatsaechlich benoetigten Einheiten verwendet. Regex nutzt die native JavaScript-RegExp-Implementierung mit Limits fuer Pattern-Laenge und Laufzeit. Eine allgemeine Utility-Sammlung wie Lodash wird nicht als weitere Pflichtabhaengigkeit eingefuehrt.

## 5. Standardisierte Artefakte

Steps tauschen keine untypisierten Einzelwerte aus, sondern Artefakte mit Wert und Herkunft:

```json
{
  "artifact_type": "candidate_set",
  "value": [
    {
      "value": "8-836.0C",
      "value_type": "string",
      "record_ref": {
        "record_id": "record-123",
        "source": "prozeduren.txt",
        "source_row_id": "4",
        "record_date": "2025-01-06"
      },
      "field": "OPCode",
      "raw_value": "8-836.0C"
    }
  ],
  "trace_ref": "trace-step-2"
}
```

Erlaubte Artefakt-Typen:

- `record_set`
- `object`
- `candidate_set`
- `value`
- `validated_value`
- `evidence_set`
- `error`

Jede Transformation muss die Provenance der Eingangskandidaten weiterfuehren. Bei Aggregationen werden alle verwendeten Kandidaten unter `selection.candidates` gespeichert; der gewaehlte Kandidat wird unter `selection.selected` markiert.

## 6. Kanonisches Pipeline-Ergebnis

Run und Test liefern dasselbe fachliche Schema:

```json
{
  "schema_version": "1.0",
  "status": "ok",
  "subject": { "patient_id": "patient-123" },
  "parameter": {
    "parameter_id": "parameter-1",
    "key": "hba1c",
    "output_type": "continuous"
  },
  "result": {
    "value": 6.8,
    "value_type": "number",
    "normalized": 6.8,
    "quality": { "valid": true, "confidence": 0.9 }
  },
  "provenance": {
    "final_step_id": "result",
    "source": "labor.csv",
    "source_row_id": "42",
    "record_id": "record-123",
    "field": "HbA1c",
    "steps": []
  },
  "trace": {
    "pipeline_version": 1,
    "steps": []
  },
  "warnings": [],
  "errors": []
}
```

Bei `status=error` oder `status=missing` bleibt das Huelle-Schema erhalten. Es muss mindestens enthalten:

- `failed_step_id`, falls ein Step bekannt ist,
- Fehlercode und menschenlesbare Meldung,
- `retryable`,
- alle bis zum Fehler erzeugten Provenance-/Trace-Informationen.

## 7. nvent / iii Architektur

Die Runtime verwendet den iii-Engine-Integrationsstand des nvent-Feature-Branches. `defineFunction` ist ein einzelner idempotenter Arbeitsschritt; `defineWorkflow` ist die fachliche Orchestrierungseinheit. Ein grosser Evaluator, der intern Baseline, Parameter, Trace und Persistenz synchron ausfuehrt, ist nicht zulaessig.

### 7.1 Orchestrierungsgrenzen

Die Ausfuehrung wird in verschachtelte Workflows zerlegt:

```text
cohort-run
  -> ctx.loop(patients, mode=batch)
     -> callWorkflow(cohort::patient-extraction)
        -> callWorkflow(cohort::extraction-pipeline, baseline)
        -> ctx.loop(parameters, mode=parallel|batch)
           -> callWorkflow(cohort::extraction-pipeline, parameter)
  -> analyze-run
  -> finalize-run

cohort-test
  -> callWorkflow(cohort::patient-extraction, persist_test_run=true)
     -> persist-test-snapshot
```

`cohort::patient-extraction` ist fuer Run und Test identisch. Nur Persistenz-, Trace-, Raw- und Retry-Optionen unterscheiden sich. Jeder Child-Workflow besitzt eine eigene Run-ID, einen eigenen State-Scope und einen eigenen Stream.

### 7.2 Wiederverwendbare Functions

Fachliche Functions sind klein, projektgebunden, read-only gegen Quelldaten und idempotent. Sie enthalten keine Schleifen ueber Patienten oder Pipeline-Steps und starten keine parallelen Nebenlaeufigkeiten:

```text
server/functions/cohort/pipeline/loadRecords.ts
server/functions/cohort/pipeline/selectRecords.ts
server/functions/cohort/pipeline/joinRecords.ts
server/functions/cohort/pipeline/mergeValues.ts
server/functions/cohort/pipeline/extractValue.ts
server/functions/cohort/pipeline/transformValue.ts
server/functions/cohort/pipeline/aggregateValues.ts
server/functions/cohort/pipeline/validateValue.ts
server/functions/cohort/pipeline/normalizeResult.ts
server/functions/cohort/persistResult.ts
server/functions/cohort/persistTestSnapshot.ts
```

`llm_extract` ist keine normale Function mit verstecktem Provider-Aufruf. Der Step wird im Pipeline-Workflow als `ctx.agent()` ausgefuehrt. So bleiben Agent-Session, Turns, Retry-/Timeout-Grenzen, Stream und Agent-Trace Teil des durablen Workflow-Laufs.

### 7.3 Pipeline-Workflow

```text
server/workflows/cohort/extraction-pipeline.ts
```

Der Workflow erhaelt einen vollstaendigen, bereits validierten Pipeline-Snapshot. Er laedt Records ueber `ctx.call`, fuehrt die Steps in Reihenfolge aus und liefert ein `ExtractionResult` zurueck:

1. `loadRecords` als eigener Function-Node.
2. Jeder fachliche Step als eigener Function-Node mit `ctx.call`.
3. `llm_extract` als echter `ctx.agent`-Node mit strukturiertem Ergebnisvertrag.
4. Nach jedem Node werden Step-Trace, Artefakt-Referenz und Status in den Workflow-State geschrieben.
5. Ein Fehler wird anhand von `on_error` behandelt; bei `fail` endet der Workflow mit einem fachlichen Ergebnis, nicht mit einem unstrukturierten Exception-String.
6. `normalizeResult` erzeugt das kanonische Ergebnis.

Der Workflow darf die Fachlogik nicht selbst implementieren. Er verbindet Nodes, uebergibt Artefakte und kontrolliert Retry, Queue, State und Trace.

Der Pipeline-Snapshot muss vor dem Workflow-Start in `config_snapshot` und im Workflow-Input festgehalten werden. Ein laufender Workflow liest keine mutable Pipeline-Konfiguration aus der Datenbank nach.

#### 7.3.1 Flexibles Step-Modell

Die Pipeline ist eine deklarative, versionierte Liste von Step-Instanzen. Flexibel ist die
Zusammensetzung der Steps, nicht der zur Laufzeit ausfuehrbare Code. Jeder `type` verweist
auf einen beim Workflow-Compile registrierten Step-Handler. Ein Pipeline-Snapshot darf
deshalb nur bekannte Step-Typen und deren validierte Konfiguration enthalten.

```ts
type PipelineStep = {
  id: string
  type:
    | 'load_records'
    | 'select_records'
    | 'join_records'
    | 'merge_values'
    | 'extract_value'
    | 'transform_value'
    | 'aggregate_values'
    | 'validate_value'
    | 'llm_extract'
    | 'if'
  config: Record<string, unknown>
  on_error?: 'fail' | 'skip' | 'fallback'
  retry?: { max_attempts?: number; backoff_ms?: number }
  output?: { return_type?: 'memory' | 'store' }
}

type PipelineArtifact = {
  kind: string
  value?: unknown
  ref?: { store: string; key: string }
  schema_version: string
  provenance: { step_id: string; source_refs?: string[] }
}
```

Ein Step-Handler besitzt einen stabilen, typisierten Vertrag:

```ts
type PipelineStepHandler = {
  type: PipelineStep['type']
  validateConfig(config: unknown): void
  execute(input: {
    artifact: PipelineArtifact
    context: PipelineExecutionContext
    config: Record<string, unknown>
  }): Promise<PipelineArtifact>
}
```

Die Registry wird beim Erzeugen des Workflows aufgeloest. Ein Handler darf keine unbekannte
Function-ID aus `step.config` laden und keinen beliebigen JavaScript-Code ausfuehren. Die
Zuordnung bleibt statisch und pruefbar:

```ts
const stepHandlers = {
  load_records: loadRecordsStep,
  select_records: selectRecordsStep,
  extract_value: extractValueStep,
  transform_value: transformValueStep,
  validate_value: validateValueStep,
  llm_extract: llmExtractStep,
} satisfies Record<string, PipelineStepHandler>
```

Der Workflow validiert vor der ersten Ausfuehrung die Step-IDs, Reihenfolge, Handler-Typen,
Konfiguration, Referenzen und erlaubten Fehlerpolicies. Danach wird der Snapshot nicht mehr
veraendert. Ein neuer Step-Typ oder eine geaenderte Konfigurationssemantik erzeugt eine neue
Pipeline-Version und wird nicht in einem laufenden Workflow nachgeladen.

Jede Iteration der Step-Kette verarbeitet genau ein `PipelineArtifact`:

```text
artifact_0 = initialArtifact(request)
for step in pipeline.steps:
  artifact_n+1 = executeRegisteredStep(step, artifact_n)
return normalizeResult(artifact_final)
```

Die Schleife selbst ist keine JavaScript-Schleife mit versteckten Seiteneffekten, sondern die
fachliche Beschreibung des `ctx.reduce`-Knotens. Der konkrete Handler wird als bekannter
Workflow-Node kompiliert. Fuer einfache Function-Steps ruft er eine registrierte Function
ueber `ctx.call` auf; fuer `llm_extract` erzeugt er einen `ctx.agent`-Node; fuer `if` erzeugt
er einen durable Branch-Knoten. So bleiben konfigurierbare Reihenfolge und durable Ausfuehrung
vereinbar.

Ein Step-Trace enthaelt mindestens `step_id`, `type`, `input_ref`, `output_ref`, `status`,
`started_at`, `finished_at`, `attempt`, `error` und `provenance`. Bei `skip` oder
`fallback` wird der verwendete Policy-Entscheid ebenfalls gespeichert. Ein Handler darf
keine fachliche Persistenz ausserhalb des zurueckgegebenen Artefakts ausfuehren; Persistenz
erfolgt erst durch die dafuer vorgesehenen Abschluss-Functions.

### 7.4 Durable Step-Kette und nvent-Erweiterung

`ctx.loop` ist fuer unabhaengige Items geeignet. Eine Pipeline-Step-Kette benoetigt dagegen einen akkumulierten, strikt sequenziellen Loop: Das Ergebnis von Step `n` ist der Input von Step `n+1`. Dafuer wird nvent um folgende API erweitert:

```ts
const final = await ctx.reduce(
  pipeline.steps,
  initialArtifact,
  async (accumulator, step, iteration) => {
    return await iteration.callRegisteredStep({
      registry: 'cohort-pipeline-v1',
      stepType: step.type,
      step,
      artifact: accumulator,
      context,
    })
  },
  {
    mode: 'sequential',
    itemReturnType: 'store',
    accumulatorReturnType: 'store',
  },
)
```

Verbindlicher Funktionsumfang von `ctx.reduce`:

- durable Speicherung von aktuellem Index und Accumulator,
- Wiederaufnahme nach Worker-/Server-Neustart,
- Retry nur fuer die fehlgeschlagene Iteration,
- genau ein Accumulator-Output pro Iteration,
- deterministische Iterations- und Node-IDs,
- Zugriff auf `iteration.item`, `iteration.index` und `iteration.callRegisteredStep(...)`,
- Aufloesung des Step-Typs nur ueber eine beim Compile registrierte Registry; ein freier
  String-Dispatcher aus `step.config` ist unzulaessig,
- `mode: 'sequential'`; spaetere Modi duerfen nur mit expliziter Merge-Semantik eingefuehrt werden,
- Store-Referenzen fuer grosse Artefakte statt erzwungener In-Memory-Payloads,
- strukturierte Fehler und kontrolliertes Abbrechen bei `on_error`.

`ctx.reduce` ist eine neue nvent-Primitiv-Anforderung. `ctx.loop(..., { mode: 'sequential' })` allein reicht nicht aus, weil die aktuelle API keinen fachlichen Accumulator-Vertrag garantiert.

`iteration.callRegisteredStep(...)` ist dabei eine fachliche Pipeline-Adapterfunktion und
keine allgemeine dynamische Dispatch-API. Sie darf nur die beim Workflow-Compile validierte
Registry `cohort-pipeline-v1` verwenden. Falls nvent keine Registry-Aufloesung innerhalb von
`ctx.reduce` anbietet, muss der Compiler aus dem Pipeline-Snapshot statische Child-Nodes fuer
alle erlaubten Step-Typen erzeugen; ein beliebiger Laufzeit-Import bleibt ausgeschlossen.

Falls die Engine keine Agent-Aufrufe innerhalb einer Reduce-Iteration unterstuetzt, ist zusaetzlich `iteration.agent(...)` mit derselben Semantik wie `ctx.agent(...)` erforderlich. Diese API muss Session, Turn, Retry, Timeout, Kosten, Stream und Ergebnis-Referenz als Teil der Iteration persistieren.

### 7.5 Durable Bedingungen und Verzweigungen

Eine Workflow-Pipeline benoetigt neben `fallback` auch allgemeine Bedingungen. `fallback` bedeutet: mehrere vollstaendige Kandidatenpipelines werden priorisiert versucht und der erste gueltige Output gewinnt. Eine Bedingung bedeutet dagegen: Ein bereits erzeugtes Artefakt oder ein Workflow-Ergebnis entscheidet, welcher nachfolgende Pfad ausgefuehrt wird.

Typische Bedingungen sind:

- Baseline vorhanden oder nicht vorhanden,
- Agent-Ergebnis enthaelt ausreichende Evidence oder nicht,
- Wert ist innerhalb eines konfigurierten Bereichs,
- aktueller Step ist `missing`, `failed` oder `completed`,
- Pipeline-Policy erlaubt einen Fallback oder beendet den Lauf.

Diese Entscheidungen duerfen nicht als JavaScript-`if` im Workflow-Handler ausgefuehrt werden, wenn dadurch der ausgefuehrte Pfad nicht als durable Workflow-DAG gespeichert wird. Die Engine benoetigt dafuer einen konditionalen Workflow-Knoten, zum Beispiel:

```ts
const decision = await ctx.if(
  artifact,
  {
    predicate: { path: 'value', operator: 'exists' },
    then: async branch => branch.callWorkflow('cohort::extraction-pipeline', nextRequest),
    else: async branch => branch.call('cohort::create-missing-result', missingRequest),
  },
)
```

Der konkrete Predicate-Vertrag muss deterministisch und serialisierbar sein. Zulaessige Operatoren in der ersten Version sind `exists`, `equals`, `not_equals`, `in`, `not_in`, `greater_than`, `greater_or_equal`, `less_than`, `less_or_equal` und `is_truthy`. Beliebige JavaScript-Funktionen, SQL-Ausdruecke oder Agent-Entscheidungen als Predicate sind unzulaessig.

Verbindliche Semantik:

- Das Predicate wird als eigener Workflow-Knoten mit Input-Referenz, Ergebnis und Trace gespeichert.
- Genau ein Pfad wird ausgefuehrt; der nicht gewaehlte Pfad wird als `skipped` dokumentiert.
- Der gewaehlte Pfad ist nach einem Neustart eindeutig wiederaufnehmbar und wird nicht doppelt ausgefuehrt.
- Jede Branch besitzt eigene Node-/Retry-/Queue-Policies und liefert einen typisierten Output.
- Nach einer Verzweigung darf nur ein expliziter Merge-/Join-Knoten beide moeglichen Ergebnisse wieder zusammenfuehren.
- Ein `if` darf innerhalb von `ctx.reduce` verwendet werden, ohne den Accumulator-Vertrag oder die Iterationsreihenfolge zu veraendern.

Ein moeglicher nvent-Vertrag ist:

```ts
await ctx.if(
  { from: artifact, path: 'value' },
  {
    predicate: { operator: 'greater_or_equal', value: 0 },
    then: branch => branch.call('validate-positive', artifact),
    else: branch => branch.call('create-missing-result', artifact),
  },
)
```

Alternativ kann nvent einen allgemeinen `ctx.branch({ predicate, then, else })`-Namen verwenden. Entscheidend ist, dass die Bedingung beim Workflow-Compile als serialisierbarer, durabler Knoten registriert wird. Ein normales TypeScript-`if` bleibt fuer rein statische Entscheidungen erlaubt, zum Beispiel fuer das Auswaehlen einer lokal bekannten Function-ID beim Kompilieren; datenabhaengige Entscheidungen muessen dagegen ueber diese Primitive laufen.

Die nvent-Akzeptanztests muessen mindestens abdecken:

1. Nur der gewaehlte Pfad wird ausgefuehrt.
2. Der nicht gewaehlte Pfad ist im Trace als `skipped` sichtbar.
3. Ein Neustart nach der Predicate-Auswertung setzt den gewaehlten Pfad fort.
4. Retry im gewaehlten Pfad bewertet das Predicate nicht erneut.
5. Branch-Ergebnisse koennen als Store-Referenzen an einen expliziten Merge-Knoten uebergeben werden.

#### nvent-Feature-Anforderung: `ctx.reduce`

Die Implementierung im nvent-Feature-Branch soll mindestens folgende Tests erfuellen:

1. **Accumulator:** `[1, 2, 3]` mit Accumulator `0` ergibt deterministisch `6`; jede Iteration sieht den Output der vorherigen Iteration.
2. **Durable resume:** Ein absichtlich unterbrochener Lauf wird nach dem Neustart ab Iteration `n` fortgesetzt; Iterationen `< n` werden nicht erneut ausgefuehrt.
3. **Iteration retry:** Scheitert Iteration `n` einmal transient und gelingt beim Retry, bleiben Accumulator und Trace der Iterationen `< n` unveraendert.
4. **Terminal error:** Ein nicht retrybarer Fehler beendet den Reduce-Lauf mit Iterationsindex, Step-ID, Accumulator-Referenz und strukturiertem Fehler.
5. **Store payloads:** Grosse Accumulatoren werden ueber Store-Referenzen transportiert und nicht still auf eine feste In-Memory-Grenze gekuerzt.
6. **Nested calls:** Eine Iteration kann `call`, `callWorkflow` und, falls freigegeben, `agent` als durabele Child-Nodes aufrufen.
7. **Trace order:** Der logische Trace bleibt in Iterationsreihenfolge, auch wenn interne Queue-/Worker-Ausfuehrung retried wird.

Die API muss nicht als frei verwendbare JavaScript-Schleife implementiert werden. Sie muss beim Workflow-Compile einen wiederaufnehmbaren Reduce-Knoten mit explizitem Accumulator, Iterationsquelle und Child-Nodes erzeugen. Ein moeglicher TypeScript-Vertrag ist:

```ts
ctx.reduce<TItem, TAccumulator>(
  items: WorkflowValueRef<TItem[]> | TItem[],
  initial: WorkflowValueRef<TAccumulator> | TAccumulator,
  fn: (accumulator: TAccumulator, item: TItem, iteration: WorkflowReduceContext<TItem>) => Promise<TAccumulator>,
  options?: {
    itemReturnType?: 'memory' | 'store'
    accumulatorReturnType?: 'memory' | 'store'
    retry?: { max_attempts?: number }
    queue?: string
  },
): Promise<TAccumulator>
```

Die exakten Namen duerfen sich an die nvent-Typen anpassen; die Durable-Semantik ist der Vertrag. `ctx.reduce` soll zunaechst nur `mode: 'sequential'` anbieten. Parallelisierte Reductions benoetigen spaeter eine explizite deterministische Merge-Funktion und sind nicht Teil dieser Implementierung.

### 7.6 Agent-Steps

Ein Agent-Step ist ein durabler Workflow-Node, kein versteckter synchroner HTTP-Aufruf:

```ts
const agentResult = await ctx.agent({
  prompt: step.config.prompt,
  input: artifact,
  agent: { id: step.config.agent_id },
  task: { title: step.id },
}, {
  model: step.config.model,
  maxTurns: step.config.max_turns,
  timeoutMs: step.config.timeout_ms,
  functions: { allow: step.config.allowed_functions },
  stream: { enabled: true },
  systemPromptStrategy: 'override',
  systemPrompt: step.config.system_prompt,
  result: { returnType: 'store', onMemoryFail: 'store' },
})
```

Der Agent darf nur den freigegebenen Function-/Skill-Scope verwenden. Seine Ausgabe wird als normales Pipeline-Artefakt weitergereicht und muss durch nachfolgende `transform`-/`validate`-Steps fachlich geprueft werden. Persistiert werden mindestens Agent-ID, Modell-/Prompt-Version, Session-/Turn-Referenz, strukturierte Ausgabe, Evidence, Laufzeit, Kosten-/Tokenmetadaten, Status und Fehler.

Agent-Retries sind von Pipeline-Retries zu unterscheiden: Ein transienter Provider-/Worker-Fehler darf den Agent-Node wiederholen; ein syntaktisch gueltiges, aber fachlich ungueltiges Ergebnis wird nicht automatisch wiederholt, sondern an `validate` uebergeben.

### 7.7 Cohort-Run und Test-Workflow

Der Cohort-Run und der Test verwenden denselben `cohort::patient-extraction`-Workflow:

```text
cohort::patient-extraction
  -> callWorkflow(cohort::extraction-pipeline, baseline request)
  -> ctx.loop(parameters, { mode: 'parallel' | 'batch' })
     -> callWorkflow(cohort::extraction-pipeline, parameter request + baseline)
  -> call(cohort::persist-patient-results)
```

Der Test ruft denselben Child-Workflow fuer genau einen Patienten auf und fuehrt danach `cohort::persist-test-snapshot` als separaten Function-Node aus. Dieser Node schreibt den canonical Snapshot atomar; er wird nicht in den Pipeline-Workflow eingebaut.

| Option | Cohort-Run | Test |
|---|---:|---:|
| `persist_result` | `true` | `false` |
| `persist_test_run` | `false` | `true` |
| `include_trace` | konfigurierbar | `true` |
| `include_raw` | restriktiv | `true` fuer berechtigte Nutzer |
| Patienten | viele | genau einer |
| Pipeline-Quelle | unveraenderlicher Run-Snapshot | Draft- oder gespeicherter Snapshot |
| Retry | Workflow-/Node-Policy | begrenzte, explizite Policy |

Ein Draft wird vor dem Trigger vollstaendig validiert und als unveraenderlicher Workflow-Input uebergeben. Der Test mischt keinen Draft mit einer gespeicherten Parameterdefinition.

Ein Test mit ungespeichertem Draft muss den vollstaendigen Draft mitsamt `pipeline_version` an den Workflow uebergeben. Der Test darf keine gespeicherte Parameterdefinition stillschweigend mit dem Draft vermischen.

### 7.7.1 Kanonischer Test-Snapshot

Testlaeufe verwenden ausschliesslich den folgenden Snapshot-Vertrag. `result` ist kein Alias fuer einen Test-Snapshot; es bezeichnet innerhalb eines `ExtractionResult` ausschliesslich den fachlichen Wertcontainer. Der API-Response liefert den Snapshot unter `snapshot`.

```json
{
  "schema_version": "1.0",
  "status": "completed",
  "subject": { "patient_id": "patient-123" },
  "target": { "kind": "parameter", "id": "parameter-1", "output_type": "continuous" },
  "baseline": {
    "schema_version": "1.0",
    "status": "completed",
    "subject": { "patient_id": "patient-123" },
    "target": { "kind": "baseline", "id": "cohort-baseline", "output_type": "date" },
    "result": { "value": "2024-03-15", "value_type": "string", "normalized": "2024-03-15" },
    "provenance": {},
    "trace": { "pipeline_version": 1, "pipeline_hash": "sha256:...", "steps": [] },
    "warnings": [],
    "errors": []
  },
  "results": [
    {
      "schema_version": "1.0",
      "status": "completed",
      "subject": { "patient_id": "patient-123" },
      "target": { "kind": "parameter", "id": "parameter-1", "output_type": "continuous" },
      "result": { "value": 42.5, "value_type": "number", "normalized": 42.5 },
      "provenance": {},
      "trace": { "pipeline_version": 1, "pipeline_hash": "sha256:...", "steps": [] },
      "warnings": [],
      "errors": []
    }
  ],
  "trace": {
    "baseline": [],
    "results": []
  },
  "warnings": [],
  "errors": []
}
```

Verbindliche Regeln:

- `baseline` ist immer auf Snapshot-Ebene vorhanden und enthaelt entweder ein vollstaendiges `ExtractionResult` oder `null`.
- `results` ist immer ein Array von vollstaendigen `ExtractionResult`-Objekten. Beim Baseline-Test ist es leer; beim Parameter-Test enthaelt es die Parameterergebnisse.
- `trace.baseline` enthaelt ausschliesslich die Baseline-Step-Traces.
- `trace.results` enthaelt pro Parameterziel ein Objekt mit `target` und geordneten `steps`.
- `result_snapshot` speichert den vollstaendigen kanonischen Snapshot. `trace_snapshot` speichert ausschliesslich dessen `trace`-Objekt fuer technische Abfragen.
- Der GET-Test-Endpunkt liefert `snapshot`, `status`, `target` und `history`; er liefert keine parallelen `result`-, `results`- oder `trace`-Aliase.
- Legacy-Snapshots oder gemischte Response-Formen werden nicht normalisiert und gelten als ungueltig.

## 8. UI-Anforderungen

Die Benutzeroberflaeche darf die technische Step-Liste nicht als unstrukturierte Typauswahl praesentieren. Sie fuehrt den Benutzer entlang des fachlichen Datenflusses:

1. **Records auswaehlen**: Source, Zeitraum und fachliche Filter. Hier wird `select` konfiguriert.
2. **Wert lesen**: Feld aus dem aktuellen Kontext lesen (`extract`) oder Match-Feld und Ergebnisfeld definieren (`lookup`). Eine Source-Auswahl ist hier nicht vorhanden.
3. **Wert aufbereiten**: Transformationen wie Zahl parsen, Einheit umrechnen oder Datum verschieben (`transform`).
4. **Mehrere Treffer behandeln**: Auswahlregel und Sortierung (`aggregate`). Die UI verwendet Begriffe wie „zeitlich letzter Wert“ und zeigt die technische Sortierung nur in den Details.
5. **Ergebnis pruefen**: Datentyp, Pflichtwert, Wertebereich und erlaubte Werte (`validate`).

Der Button fuer den naechsten Step bietet nur fachlich kompatible Schritte an. Nach `select` sind zum Beispiel `extract`, `lookup`, `merge` und `join` moeglich; nach `extract` oder `lookup` sind `transform`, `aggregate` und `validate` moeglich. Inkompatible Kombinationen werden nicht erst nach dem Speichern als Fehler entdeckt.

Jeder Step zeigt:

- fachlichen Titel und eine kurze Beschreibung,
- Input- und Output-Artefakt,
- nur die Konfiguration, die zu diesem Step gehoert,
- eine aufklappbare technische Detailansicht,
- Inline-Validierung mit einer fachlichen Fehlermeldung.

`direct_field` wird nicht als Typ angeboten. Eine Source-Auswahl erscheint nur bei `select` beziehungsweise in den expliziten Join-Seiten. Eine Auswahl wie „Erstes/letztes Vorkommen“ erscheint nur bei `aggregate`.

Der Parameter-Editor zeigt weiterhin eine geordnete Liste mit Step hinzufuegen, entfernen, verschieben und aktivieren/deaktivieren. Neue Steps starten ohne Typ und werden bis zur Konfiguration nicht persistiert und nicht validiert.

Fallbacks werden in V1 als vollstaendige Teilpipelines dargestellt. Neue Steps werden direkt als Pipeline-Steps konfiguriert und nicht hinter einem separaten Strategienmodell versteckt.

Der rechte Testbereich zeigt:

- den ausgefuehrten Step-Trace in Reihenfolge,
- Input und Output jedes Steps,
- finalen Wert und normalisierten Wert,
- Provenance/Evidence,
- Warnings und Fehler mit `failed_step_id`,
- ob der Test einen Draft oder einen gespeicherten Snapshot verwendet.

Raw-Daten werden standardmaessig gekuerzt und nur bei explizitem Debug-Aufruf angezeigt.

## 9. Persistenz und Versionierung

### 9.1 Parameter

Neue Spalte bzw. JSON-Feld:

- `cohorts.baseline_pipeline` — kanonische Baselinepipeline mit `target.kind=baseline`.
- `cohort_parameters.extraction_pipeline` — kanonische Pipeline-Definition.

Bestehende fachliche Felder:

- `baseline_policy` — optionale zeitliche Auswahlregel fuer die Parameterpipeline. Reihenfolge: Source-/Record-Selektion, Baseline-Einschraenkung, Candidate-Extraktion, optionale Aggregation, Transformation und Validierung.

### 9.2 Resultate

`cohort_results.provenance` erweitert sich um:

```json
{
  "pipeline_version": 3,
  "pipeline_hash": "sha256:...",
  "final_step_id": "validate-date",
  "steps": [
    {
      "step_id": "extract-date",
      "type": "extract",
      "status": "completed",
      "input_refs": ["record-123"],
      "output_summary": { "value_type": "date" },
      "duration_ms": 4
    }
  ]
}
```

Volle Roh-Inputs und LLM-Antworten werden nur nach Datenschutz-/RBAC-Regeln persistiert. Zusammenfassende Provenance bleibt immer erhalten.

### 9.3 Testlaeufe und History

Testlaeufe werden dauerhaft persistiert und niemals ueberschrieben. Jeder Test speichert einen vollstaendigen `config_snapshot` der ausgefuehrten Pipeline, des Targets, der Policies und der relevanten Input-Versionen. Dadurch bleibt nachvollziehbar, worauf sich ein Ergebnis bezog, auch wenn die aktuelle Parameterdefinition spaeter geaendert wird.

Empfohlenes Modell `cohort_extraction_test_runs`:

- `id` — Testlauf-ID
- `cohort_id`, `project_id`, `patient_id`
- `target_kind`, `target_id` — `baseline` oder `parameter` und die konkrete Ziel-ID
- `pipeline_version`, `pipeline_hash`, `config_snapshot`
- `status` — `queued|running|completed|failed|missing`
- `result_snapshot`, `trace_snapshot`
- `created_at`, `started_at`, `finished_at`
- `supersedes_test_run_id` — vorheriger Testlauf desselben Ziels und Patienten
- `is_latest` — genau ein aktueller Testlauf pro `(cohort_id, patient_id, target_kind, target_id)`

Das Aktualisieren von `is_latest` und `supersedes_test_run_id` erfolgt atomar. Die History bleibt vollstaendig erhalten; der als `is_latest=true` markierte, erfolgreich abgeschlossene Testlauf ist fuer die UI und den normalen Review-Kontext entscheidend. Fehlgeschlagene Testlaeufe werden historisiert, ersetzen aber keinen letzten erfolgreichen Lauf.

Der API-Vertrag liefert standardmaessig den aktuellen Testlauf und kann ueber einen History-Endpunkt alle frueheren Laeufe paginiert abrufen. Testlaeufe verfalschen keine normalen Cohort-Reports und werden nicht als `cohort_results` eines Produktions-Runs gespeichert.

### 9.4 Trace- und Raw-Ausgaben

Es gibt keine kuenstlich kleine feste Truncation fuer gut aufbereitete Testdaten. Der vollstaendige strukturelle Trace wird persistiert; grosse Raw-Inhalte und LLM-Antworten werden separat referenziert oder paginiert geladen. Die Standardansicht zeigt Zusammenfassungen, Schrittstatus, Provenance und Evidence direkt; ein Debug-Aufruf kann die vollstaendigen Inputs/Outputs nach RBAC-Pruefung abrufen.

Die API muss dennoch konfigurierbare Schutzgrenzen besitzen: maximale Antwortgroesse, Pagination fuer grosse Artefakte, Timeout und serverseitige Redaction sensibler Felder. Diese Grenzen dienen Betrieb und Datenschutz, nicht einer fachlichen Verkuerzung des gespeicherten Traces.

## 10. Validierung und Fehlercodes

Pipeline-Konfiguration:

- `PIPELINE_SCHEMA_INVALID`
- `STEP_TYPE_UNKNOWN`
- `STEP_CONFIG_INVALID`
- `STEP_INPUT_TYPE_MISMATCH`
- `PIPELINE_CYCLE_DETECTED` (falls spaeter Referenzen eingefuehrt werden)

Laufzeit:

- `NO_RECORDS`
- `NO_CANDIDATES`
- `LOOKUP_NO_MATCH`
- `TRANSFORM_FAILED`
- `AGGREGATION_EMPTY`
- `VALIDATION_FAILED`
- `LLM_EXTRACTION_FAILED`
- `RESULT_MISSING`

Legacy-Konfigurationen mit `direct_field`, `extraction_logic` oder `extraction_strategies` werden als `PIPELINE_SCHEMA_INVALID` abgelehnt. Sie werden weder stillschweigend ignoriert noch in kanonische Steps umgeschrieben.

Jeder Fehler enthaelt `code`, `message`, `step_id`, `retryable` und optional technische Details. Ein fehlender Wert ist nicht automatisch ein technischer Fehler; er wird als `missing` mit nachvollziehbarem Trace ausgegeben.

## 11. Sicherheit

- `project_id`, `patient_id` und Parameterzugriff werden serverseitig aus dem aktiven Projektkontext validiert.
- Pipeline-Konfigurationen duerfen keine beliebigen SQL-Ausdruecke oder JavaScript-Ausfuehrung enthalten.
- LLM-/Agent-Steps verwenden die bestehende lokale nvent-Agent-Infrastruktur und speichern Modell-/Prompt-Versionen im Trace.
- Agent-Calls duerfen nur innerhalb eines laufenden nvent-Workflows ueber den freigegebenen Agent-Context erfolgen; Pipeline-Konfigurationen koennen keine beliebigen Provider, Tools oder Funktionspfade ausfuehren.
- LLM-Ausgaben werden vor jeder Persistierung und vor der Verwendung als finales Resultat durch explizite Schema-/Typ-/Fachvalidierungsschritte geprueft.
- Raw-Daten und LLM-Ausgaben unterliegen RBAC und konfigurierbarer Aufbewahrung.

## 12. Umsetzung

### Phase 0 - Semantische Bereinigung

Vor weiteren UI-Erweiterungen werden Pipeline-Vertrag und bestehende Konfigurationen bereinigt:

1. `direct_field` ist kein gueltiger Step-Typ und wird bei Validierung, Speichern, Test und Run abgelehnt.
2. `lookup` wird als eigener kanonischer Step-Typ registriert und nicht mehr stillschweigend zu `extract` umgeschrieben.
3. `source` wird aus `extract`- und `lookup`-Konfigurationen entfernt; die Record-Auswahl erfolgt vorher durch `select` oder `join`.
4. `occurrence` wird aus Feld-, Lookup- und Transformations-Steps entfernt; Mehrfachwerte werden explizit mit `aggregate` reduziert.
5. `aggregate.first` und `aggregate.last` erhalten eine explizite und deterministische Sortierung.
6. Validator und Runner prüfen dieselben Artefakt-Uebergaenge und melden inkompatible Step-Reihenfolgen.
7. Alte Pipelineformate werden nicht automatisch migriert. Sie werden bei Laden, Speichern, Test und Run abgelehnt; eine Umstellung erfolgt nur durch ein separates, explizit gestartetes Migrationswerkzeug oder durch Neuanlage.

### Phase 1 — Runtime-Abstraktion

1. Kanonische Artefakt-, Target-, Context- und Result-Typen definieren.
2. Bestehende `evaluatePatient`-Logik in einzelne Pipeline-Functions zerlegen; der Evaluator bleibt nicht als Orchestrator bestehen.
3. `cohort::extraction-pipeline` als Workflow mit `ctx.call`, `ctx.agent` und `ctx.reduce` einfuehren.
4. `cohort::patient-extraction` als gekapselten Child-Workflow fuer Baseline und Parameter einfuehren.
5. Durable `ctx.if`/`ctx.branch`-Verzweigungen mit serialisierbaren Predicates einfuehren.
6. Baseline- und Parameter-Test auf denselben Patient-Workflow umstellen.

### Phase 1a — nvent-Voraussetzungen

1. `ctx.reduce` gemaess Abschnitt 7.4 in nvent spezifizieren, kompilieren und mit Neustart-/Retry-Tests absichern.
2. `ctx.if`/`ctx.branch` gemaess Abschnitt 7.5 mit Neustart-, Skip- und Retry-Tests implementieren.
3. Sicherstellen, dass `ctx.agent()` innerhalb einer durablen Workflow-Iteration verwendet werden kann und Agent-Resultate als Store-Referenzen weitergereicht werden.
4. `ctx.callWorkflow()` fuer Child-Workflows inklusive eigenem State-/Stream-Scope und terminalem Fehlerstatus validieren.
5. Queue- und Retry-Policies auf Function-, Workflow- und Node-Ebene dokumentieren und im Monitoring sichtbar machen.

### Phase 2 — Persistenz und Versionierung

1. `cohorts.baseline_pipeline` und `cohort_parameters.extraction_pipeline` als kanonische JSON-Felder ergaenzen.
2. Gemeinsames Target-/Pipeline-Schema und Step-Versionen validieren.
3. Pipeline-Snapshot, `pipeline_version` und `pipeline_hash` zusammen mit jedem Run speichern.
4. `provenance.steps`, Target, Pipeline-Version und Pipeline-Hash in Resultaten speichern.

### Phase 3 — UI

1. Bestehende Strategy-Editoren als Pipeline-Step-Editor weiterverwenden.
2. Reihenfolge und Zwischensteps sichtbar machen.
3. `merge`, `join`, `validate` und mehrere Transform-Schritte ergaenzen.
4. Testpanel um Step-Trace und Fehler pro Step erweitern.

### Phase 4 — Erweiterte iii-Steps

1. `llm_extract` als standardisierten Step mit Evidence implementieren.
2. Retry-, Timeout- und Kostenlimits pro Step konfigurieren.
3. Optional parallele unabhaengige Teilpipelines einfuehren; der kanonische Merge bleibt explizit.
4. `custom_function` erst nach einem separaten Sicherheits-, Registry- und Governance-Entwurf umsetzen.

## 13. Akzeptanzkriterien

- Ein Parameter kann mindestens `select -> extract -> transform -> aggregate -> validate` ausfuehren.
- Ein Parameter kann `select -> lookup -> aggregate -> validate` ausfuehren, ohne dass `lookup` eine eigene Source-Auswahl benoetigt.
- Ein Parameter kann mehrere Transformationen im Wert-/Candidate-Datenfluss ausfuehren.
- Records/Felder koennen vor der Extraktion zusammengefuehrt werden.
- Jeder Step erscheint in einem Test-Trace mit Input, Output, Status und Provenance.
- Test und Cohort-Run verwenden denselben Patient-Workflow, Pipeline-Workflow und dieselben iii Functions.
- Baseline, Patient, Pipeline und Persistenz sind getrennte durabel wiederaufnehmbare Workflow-/Function-Nodes.
- Ein Pipeline-Workflow kann nach einem Worker-Neustart an der letzten abgeschlossenen Step-Iteration fortsetzen.
- Ein fehlgeschlagener Step wird ueber die konfigurierte Queue-/Retry-Policy erneut ausgefuehrt, ohne bereits abgeschlossene Steps zu wiederholen.
- Ein Cohort-Run kann Patienten ueber `ctx.loop` in `batch`- oder begrenzter `parallel`-Ausfuehrung verarbeiten.
- Ein Patient-Workflow kann Parameter nach Abschluss der Baseline ueber `ctx.loop` parallel oder in Batches ausfuehren.
- Ein Test-Workflow persistiert den Snapshot erst in einem separaten atomaren Persistenz-Node.
- Datenabhaengige Pipeline-Entscheidungen laufen ueber einen durablen `if`-/`branch`-Knoten; der nicht gewaehlte Pfad wird als `skipped` getraced.
- Ein Retry in einem gewaehlten Branch bewertet das Predicate nicht erneut.
- Baseline und Parameter verwenden denselben Pipeline-Runner, dieselben Artefakte und dieselben Fehler-/Trace-Vertraege.
- Eine Baseline kann durch dieselben Steps wie ein Parameter extrahiert werden und liefert lediglich ein anderes validiertes Output-Schema (`date`).
- Ein `llm_extract`-Step kann in Baseline- und Parameterpipelines vorkommen und wird ueber nvent `ctx.agent()` ausgefuehrt.
- LLM-/Agent-Outputs koennen durch nachfolgende `transform`- und `validate`-Steps fachlich geprueft und normalisiert werden.
- Ein Draft-Test verwendet exakt den uebergebenen Draft.
- Ein Fehler in einem Step zeigt den Step, Fehlercode und die bisherige Evidence.
- Fehlende Werte werden als `missing` und nicht als erfolgreicher Nullwert ausgegeben.
- Ein Cohort-Run kann pro Patient und Parameter idempotent wiederholt werden.
- `extraction_pipeline` ist die einzige Runtime-Quelle fuer neue und bestehende gueltige Parameter.
- Alte Parameterformate mit `extraction_logic`, `extraction_strategies` oder `direct_field` werden nicht als Fallback gelesen und nicht automatisch konvertiert.
- `direct_field` wird nicht als kanonischer Step-Typ gespeichert.
- `source` wird nicht in `extract`, `lookup`, `transform`, `aggregate` oder `validate` gespeichert.
- Die Auswahl mehrerer Treffer wird ausschliesslich durch `aggregate` mit explizitem `order_by` modelliert.
- `lookup` ist ein eigenstaendiger kanonischer Step-Typ und wird nicht zur Laufzeit in `extract` umgewandelt.
- `llm_extract` wird nur innerhalb eines laufenden Workflows ueber `ctx.agent()` ausgefuehrt; Provider-Aufrufe aus normalen Functions sind unzulaessig.
- Agent-Session, Turn, Modell, Prompt-Version, Evidence, Kosten-/Tokenmetadaten und Retrystatus sind im Step-Trace referenzierbar.
- Pipeline-Steps werden nicht in einem einzigen synchronen Evaluator versteckt.
- Kein Pipeline-Step erzeugt horizontales UI-Scrolling oder unkontrollierte Rohdaten-Ausgaben.

## 14. Festgelegte Entscheidungen

Festgelegt:

- `join` verbindet in V1 nur Record-Sets desselben Patienten und Projekts. Projektweite Lookup-Joins sind ein spaeterer Erweiterungspunkt mit eigenem Berechtigungs-, Versionierungs- und Kardinalitaetskonzept.
- `zod` wird fuer Schema-/Typvalidierung verwendet; `date-fns` wird fuer Datums- und Intervalloperationen eingefuehrt. Einheiten werden ueber eine versionierte Conversion-Registry verarbeitet; Regex bleibt native RegExp mit Laufzeitlimits.
- Jeder Cohort-Run und Testlauf speichert den Pipeline-Snapshot sowie `pipeline_version` und `pipeline_hash`. Eine separate Konfigurationshistorientabelle fuer Baselines ist in V1 nicht erforderlich.
- Testlaeufe werden dauerhaft mit Pipeline-/Target-/Input-Snapshot gespeichert. Die History bleibt erhalten; pro Patient und Ziel gibt es einen atomar markierten aktuellen (`is_latest`) Testlauf. Der letzte erfolgreiche Lauf ist fuer den normalen Review-Kontext entscheidend.
- Nur ein abgeschlossener und fachlich valider Testlauf wird `is_latest=true`. `missing`- und `failed`-Laeufe bleiben in der History sichtbar, ersetzen aber keinen letzten erfolgreichen Lauf.
- Vollstaendige strukturierte Traces werden gespeichert. Raw-Inputs und LLM-Antworten werden aufbereitet, RBAC-geschuetzt und bei Bedarf paginiert geladen; es gibt keine fachlich motivierte harte Kleinbegrenzung.
- Strukturierte LLM-Antworten und Evidence werden dauerhaft gespeichert. Rohantworten unterliegen einer projektweit konfigurierbaren Aufbewahrungsfrist und RBAC-Regeln.
- `custom_function` wird in V1 nicht implementiert. Der Step bleibt lediglich als reservierter Erweiterungspunkt dokumentiert.
- Pipeline-Steps laufen innerhalb eines `ctx.reduce` in V1 sequenziell. Unabhaengige Parameterpipelines duerfen auf Patient-Workflow-Ebene mit `ctx.loop` parallel oder in Batches laufen.
- Cohort- und Patient-Ausfuehrung werden als Child-Workflows gekapselt; Tests verwenden dieselben Child-Workflows wie Produktions-Runs.
- `ctx.reduce` ist die einzige neue nvent-Primitiv-Anforderung fuer die erste Runtime-Implementierung. Eine dynamische `dispatch`-API wird nicht vorausgesetzt; die konkrete Pipeline wird vor dem Trigger validiert und als Snapshot uebergeben.
