# nvent Spec: iii 0.23 Namespaces As Core Concept

Status: Draft 0.2  
Date: 2026-09-08  
Scope: nvent core runtime, worker registration, triggering, workflow dispatch, RBAC integration

## 1. Context

iii 0.23 fuehrt Namespaces als harte Routing-Dimension ein. nvent muss dieses Verhalten als Standardmodell uebernehmen statt nur default implizit zu nutzen.

Quellen:
- https://iii.dev/docs/upgrading/from-0-22-x
- https://iii.dev/docs/using-iii/namespaces
- https://iii.dev/docs/understanding-iii/namespaces

## 2. Ziele

1. Namespaces sind in nvent erstklassig konfigurierbar.
2. Worker-Registrierung, Function-Aufrufe und Trigger-Bindings sind namespace-korrekt.
3. Cross-namespace Calls sind explizit und sicher.
4. RBAC und Browser-Worker koennen namespace-scoped Regeln sauber abbilden.
5. Keine Legacy-Semantik aus pre-0.23 wird weitergefuehrt.

## 3. Nicht-Ziele

1. Vollstaendige Multi-Engine-Orchestrierung in diesem Schritt.
2. Automatische Migration fremder iii-Ressourcen ausserhalb von nvent.
3. UI-Neudesign fuer Multi-Namespace-Verwaltung in diesem ersten Cut.

## 4. Kernregeln aus iii 0.23

1. Routing-Key ist (namespace, function_id) und (namespace, worker_name).
2. Kein Namespace-Fallback bei Triggern auf andere Namespaces.
3. Worker-Namespace wird aus SDK-Option, dann III_NAMESPACE, sonst default aufgeloest.
4. engine::* ausserhalb default kann Konflikte erzeugen.
5. Namespace-Fehler muessen als Startup-/Runtime-Fehler sichtbar werden.

## 5. nvent Zielbild

### 5.1 Namespace-Konfiguration im Nuxt-Config-Modell

nvent erhaelt ein explizites Namespace-Modell:

```ts
nvent: {
  iii: {
    namespace: {
      mode: 'single' | 'mapped',
      default: 'default',
      map: {
        app: 'default',
        workflows: 'default',
        browser: 'default',
        compose: 'default'
      }
    }
  }
}
```

Semantik:
1. single: ein Namespace fuer alle nvent-Rollen.
2. mapped: getrennte Namespaces je Rolle.
3. Ohne Angabe gilt default als expliziter nvent-Default.

### 5.2 Rollen in nvent

1. app: Node/Nitro Worker-Registrierung von server/functions.
2. workflows: Workflow-Worker und interne workflow::* Aufrufe.
3. browser: Worker-Manager/RBAC Browser-Verbindungen.
4. compose: Namespace fuer compose::* Daemon (relevant im Compose-Spec).

### 5.3 API-/Runtime-Verhalten

1. registerWorker in Node/Python/Rust bekommt namespace explizit aus nvent runtime config.
2. Interne trigger(...) Wrapper erlauben optional namespace override.
3. Workflow-Dispatch nutzt standardmaessig map.workflows.
4. Builtins in default bleiben explizit default, wenn iii das verlangt.

## 6. Schnittstellen-Aenderungen (geplant)

### 6.1 defineFunction / runtime metadata

1. Optionales function-level namespace override fuer Spezialfaelle.
2. Trigger-Bindings koennen namespace und trigger_namespace ausdruecken.

### 6.2 defineWorkflow

1. Workflow-Start nutzt workflow namespace explizit.
2. Lifecycle Hooks behalten payload merge, koennen optional target namespace erhalten.

### 6.3 Browser RBAC

1. expose_functions Regeln werden namespace-scoped erzeugt.
2. allowed_functions/default-Verhalten wird an iii 0.23 angepasst.
3. Optionaler namespaces Block im Auth-Resolver-Result wird unterstuetzt.

## 7. Migrationsstrategie

Breaking Migration (ein Zielpfad)
1. Namespaces werden in allen nvent-Runtimes explizit beruecksichtigt.
2. Startup-Logs zeigen effektive Namespaces je Rolle.
3. Konflikte (WORKER_NAMESPACE_CONFLICT, FUNCTION_NAMESPACE_CONFLICT) werden als harte Setup-Fehler behandelt.
4. Validation in dev/build fuer engine::* in nicht-default ist standardmaessig aktiv.
5. Validation fuer fehlende namespace-Rules bei RBAC ist standardmaessig aktiv.

## 8. Tests und Akzeptanzkriterien

1. Single-namespace Setup laeuft unveraendert weiter.
2. Mapped-namespace Setup registriert Rollen in jeweils richtigen Namespaces.
3. Cross-namespace Trigger ohne explizites namespace schlagen reproduzierbar fehl.
4. RBAC-Regeln mit namespace greifen korrekt fuer Browser-Sessions.
5. Workflow-Start, Status, Hooks funktionieren in mapped Mode inklusive merge.

## 9. Entscheidungen zur Spezifikation

1. Hook-Targets duerfen optional einen festen target namespace erhalten.
2. Fehlt ein Hook-namespace, gilt standardmaessig der workflow Namespace (map.workflows).
3. Hook-Objekte nutzen damit folgende Semantik: function plus optional input plus optional namespace.
4. Initiale Default-Map fuer mode=mapped ist rollenbasiert und explizit getrennt:
  - app: app
  - workflows: workflows
  - browser: browser
  - compose: compose
5. Builtin engine Funktionen bleiben in default und werden von nvent intern explizit mit namespace=default angesprochen, falls erforderlich.
6. trigger_namespace Validation ist strikt und standardmaessig aktiv.
7. Fuer Custom Trigger Provider gilt: trigger_namespace muss explizit gesetzt sein; implizite Provider-Aufloesung ist in nvent nicht erlaubt.
8. Fuer bekannte Engine-Builtin Trigger (http, cron, state, stream) darf trigger_namespace nicht auf einen fremden Namespace gesetzt werden; wenn gesetzt, dann nur default.
9. Verstoesse gegen 6 bis 8 erzeugen Build-Fehler und werden nicht als Warnung behandelt.

## 10. Deliverables fuer Implementierung

1. Config-Types und Runtime-Normalizer fuer namespace model.
2. Worker-Init Updates (Node + Python runtime scripts) fuer namespace propagation.
3. Trigger/Function Wrapper Updates fuer explizite namespace Steuerung.
4. Tests: unit + integration + e2e fuer single/mapped/cross-namespace.
