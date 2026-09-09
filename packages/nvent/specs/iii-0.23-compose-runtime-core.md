# nvent Spec: iii Compose As Primary Runtime

Status: Draft 0.2  
Date: 2026-09-08  
Scope: nvent module runtime architecture, deployment packaging, local dev and production operation

## 1. Context

iii 0.23 verschiebt den Schwerpunkt auf Compose als Runtime-Orchestrierung. nvent soll sein iii-Binding darauf neu ausrichten.

Quellen:
- https://iii.dev/docs/upgrading/from-0-22-x
- https://iii.dev/docs/using-iii/compose
- https://iii.dev/docs/understanding-iii/compose

## 2. Zielbild

1. Compose ist der einzige Laufzeitweg fuer nvent.
2. Nuxt konfiguriert iii und Compose deklarativ.
3. Build erzeugt ein deploybares iii-Artefaktverzeichnis.
4. Betrieb ist flexibel:
   - getrennt skaliert: iii/compose in separatem Container
   - all-in-one: nvent startet alles automatisiert

## 3. Nicht-Ziele

1. Rueckwaertskompatibilitaet fuer pre-0.23 engine lifecycle Modes.
2. Parallelbetrieb alter und neuer Runtime-Modelle.

## 4. Compose Kernkonzepte fuer nvent

1. compose daemon als Worker, steuerbar ueber compose::* Funktionen.
2. worker-compose.yaml als source of truth fuer Projektlaufzeit.
3. Daemon Namespace, Project File, Project Namespace sind getrennte Identitaeten.
4. Readiness basiert auf Engine-Registrierung, nicht nur Prozessstatus.
5. Compose verwaltet Worker-Umgebung inkl. reservierter III_* Variablen.

## 5. Ziel-Architektur in nvent

### 5.1 Betriebsmodi

Modus A: Embedded/Managed
1. nvent startet Engine + Compose automatisch.
2. Geeignet fuer lokale Entwicklung und einfache Deployments.

Modus B: External Compose Runtime
1. Nuxt-App verbindet sich nur ueber III_URL zu externer Runtime.
2. Compose + Engine laufen in separatem Service/Container und sind separat skalierbar.

### 5.2 Konfigurationsmodell (geplant)

```ts
nvent: {
  iii: {
    compose: {
      managed: true,
      daemonNamespace: 'default',
      file: './worker-compose.yaml',
      upOnStart: true
    }
  }
}
```

Semantik:
1. Compose ist implizit aktiv; es gibt keinen runtime Switch.
2. managed=true bedeutet, dass nvent den Compose-Daemon als Child-Prozess startet, ueberwacht und bei Shutdown kontrolliert beendet; Engine-Lifecycle laeuft dabei ueber Compose.
3. managed=false nutzt externe Compose/Engine Instanzen.
4. managed=true beinhaltet einen CLI-Readiness-Check: wenn `iii` lokal nicht verfuegbar ist, installiert nvent die benoetigten iii Binaries automatisch in das nvent-Artefaktverzeichnis.

## 6. Build- und Deploy-Konzept

### 6.1 Neues Artefaktlayout

Beim nuxt build wird ein nvent iii Paketverzeichnis erzeugt, zum Beispiel:

1. .output/nvent/compose/worker-compose.yaml
2. .output/nvent/bin/iii
3. .output/nvent/bin/iii-worker
4. .output/nvent/bin/iii-console optional
5. .output/nvent/config/ fuer engine/worker Konfigurationen

Zusaetzlich gilt:
1. nvent generiert worker-compose.yaml deklarativ aus der Nuxt-Konfiguration.
2. Das Compose-File muss paketbasierte Worker (package://...) unterstuetzen, damit spaeter z. B. iii-harness und weitere Runtime-Pakete sauber eingebunden werden koennen.

### 6.1.1 Nuxt-native Verzeichnisstrategie

Ziel: maximale Integration in Nuxt-Standards bei minimaler Komplexitaet fuer Nutzer.

1. Es gibt genau ein logisches nvent-Runtime-Root pro Modus:
  - Dev: .nuxt/nvent/
  - Build/Prod: .output/nvent/
2. Die innere Struktur ist in beiden Modi identisch (bin/, compose/, config/, workers/, functions/).
3. Alle Runtime-Komponenten nutzen nur noch einen zentralen Resolver (z. B. resolveNventDir), keine verteilten Sonderpfade.
4. Standardmaessig werden keine zusaetzlichen Projektwurzel-Ordner benoetigt.
5. Optionales Override bleibt erlaubt (NVENT_DIR), ist aber ein Expertenpfad und nicht der Regelfall.
6. Dokumentation und Logs referenzieren nur dieses eine Runtime-Root, um Betriebsaufwand niedrig zu halten.

### 6.2 Docker-Strategien

Strategie 1: Single image
1. Nuxt + iii + compose in einem Image.
2. Einfache Inbetriebnahme.

Strategie 2: Split runtime
1. Nuxt-App Image.
2. Compose/iii Runtime Image mit worker-compose.yaml.
3. Kommunikation ueber Netzwerk/III_URL.
4. Unabhaengige Skalierung von API und Worker-Laufzeit.

## 7. Integration in bestehende nvent Komponenten

1. module.ts erzeugt Compose-Artefakte und RuntimeConfig.
2. 00.iii-lifecycle.ts startet in managed Mode compose-first statt engine-first.
3. 01.iii-worker.ts bleibt fuer Node/Python-Worker-Registrierung relevant, wird aber Compose-kompatibel verdrahtet.
4. install.ts/console.ts werden compose-aware Version/Asset Handling nutzen und im managed Mode die Verfuegbarkeit von `iii`/`iii-worker` vor dem Compose-Start sicherstellen.
5. registry.ts bleibt fuer lokale Worker-Discovery, kann in Compose-Generierung einfliessen.

## 7.1 Integration des nvent Workflow-Workers in Compose

Aktueller Zustand:
1. Der nvent Workflow-Worker wird als npm Paket ausgeliefert.
2. Die Auslieferung ist nicht direkt als offizielles iii Registry Package integriert.

Zielloesung (jetzt):
1. nvent integriert den Workflow-Worker in worker-compose.yaml als lokalen path Worker.
2. Die Compose-Generierung erzeugt dafuer einen festen Container-Eintrag, z. B. `workflow`.
3. Der Container verweist auf den durch nvent bereitgestellten Runtime-Pfad im Nuxt-Root:
  - Dev: path://./.nuxt/nvent/workers/workflow
  - Build/Prod: path://./workers/workflow relativ zu .output/nvent/compose/worker-compose.yaml
4. Der Start erfolgt ueber ein von nvent generiertes scripts.run Kommando, das auf das ausgelieferte Binary zeigt.
5. Versionierung des Workers bleibt zunaechst ueber das npm Paket und nvent Release gekoppelt.

Zielloesung (spaeter, optional):
1. Sobald die iii Registry fuer diesen Worker stabil verfuegbar ist, kann nvent optional auf package:// umstellen.
2. Die Umstellung erfolgt ohne API-Bruch ueber einen Generator-Switch, z. B. `compose.workflowWorkerSource = 'path' | 'package'`.
3. Standard bis zur Freigabe bleibt `path`.

Validierungsregeln:
1. Build bricht ab, wenn der erwartete Workflow-Worker Pfad/Binary nicht vorhanden ist.
2. Managed startup bricht ab, wenn Compose den Workflow-Container nicht auf `ready` bringt.
3. Die erzeugte Compose-Datei muss fuer beide Quellen (`path` und spaeter `package`) durch compose::validate laufen.

## 8. Migration von aktuellem nvent Verhalten

Breaking Migration (ein Zielpfad)
1. Legacy engine mode wird entfernt.
2. lifecycle/startup wird compose-first umgesetzt.
3. Dokumentation und Templates werden auf compose-only Modell umgestellt.
4. Bestehende Konfigurationen muessen auf compose Felder migriert werden.

## 9. Betriebs- und Fehlerbild

1. compose::status und compose::logs werden primäre Diagnose-Schnittstellen.
2. Typische Fehlercodes werden in nvent Fehlermeldungen gemappt:
   - PROJECT_DID_NOT_START
   - STARTUP_TIMEOUT
   - INVALID_NAMESPACE
   - ENGINE_STARTUP_TIMEOUT
   - MANAGED_ENGINE_ENDPOINT_MISMATCH
3. nvent zeigt actionable Hinweise je Code.

## 10. Security und Isolation

1. Reserved env Variablen von Compose nicht ueberschreiben.
2. Namespace-Isolation als primäre Tenant-Grenze.
3. RBAC Regeln explizit namespace-scoped konfigurieren.
4. Cross-namespace Calls nur explizit und auditierbar.

## 11. Tests und Akzeptanzkriterien

1. Managed compose mode startet lokal reproduzierbar.
2. External runtime mode verbindet ohne lokalen Engine-Start.
3. worker-compose.yaml wird valide generiert.
4. compose::up/down/status/logs funktionieren aus nvent Flows.
5. Build-Artefakte sind in Docker Single- und Split-Setup nutzbar.

## 12. Entscheidungen zur Spezifikation

1. worker-compose.yaml wird mit einer stabilen schemaVersion versioniert (Start: 1) und pro nvent Build mit Generator-Metadaten versehen.
2. nvent Minor/Patch Releases duerfen nur rueckwaertskompatible Generator-Aenderungen an schemaVersion 1 ausliefern; schemaVersion-Erhoehungen sind nur in nvent Major Releases erlaubt.
3. Nuxt-Config koppelt nicht 1:1 auf engine.workers, sondern auf ein kuratiertes, validiertes Feldset mit sicheren Defaults.
4. Fuer erweiterte Faelle gibt es einen expliziten Advanced-Block unter compose.engine, aber nur fuer whitelisted Felder von iii 0.23.
5. Unbekannte oder nicht erlaubte engine-Felder erzeugen einen Build-Fehler statt stiller Uebernahme.
6. Jeder Build validiert die generierte worker-compose.yaml gegen compose::validate, bevor Artefakte final geschrieben werden.
7. In managed Mode ist Auto-Installation der iii CLI/Binaries verpflichtend, falls sie lokal fehlen oder nicht zur geforderten Version passen.
8. Der nvent Workflow-Worker wird initial als path:// Worker in Compose integriert; package:// ist ein spaeterer optionaler Migrationspfad.

## 14. Entscheidungen (fest)

1. Es gibt keinen engine mode mehr in nvent.
2. Es gibt keinen runtime Selector mehr.
3. nvent unterstuetzt nur compose-basierte Runtime in iii 0.23+.
4. Im managed Mode steuert nvent Compose als Child-Prozess (start, monitor, graceful stop).
5. Mindestversion fuer die iii Runtime ist >= 0.23.x.
6. Das Compose-File wird aus Nuxt-Config generiert und ist die zentrale Deploy-Quelle.
7. Die Compose-Template-Versionierung folgt schemaVersion + Generator-Metadaten pro Build.
8. Die Kopplung zwischen Nuxt-Config und engine.workers ist kuratiert und strikt validiert, nicht frei durchgereicht.
9. Der Compose-Startup-Pfad in managed Mode darf nicht voraussetzen, dass `iii` global installiert ist.
10. Das iii-Runtime-Verzeichnis ist Nuxt-nativ organisiert: .nuxt/nvent (dev) und .output/nvent (build/prod) mit identischer Unterstruktur.

## 13. Deliverables fuer Implementierung

1. Neue runtime/config types fuer compose mode.
2. Compose file generator inkl. namespace integration.
3. Lifecycle plugin refactor fuer compose-first startup.
4. Deploy/Docker Beispiele fuer single und split architecture.
5. End-to-end tests fuer managed und external compose mode.
6. CLI/Binary bootstrap fuer managed mode (Install/Version-Check/Fallback-Fehlerbild).
7. Compose-Generator-Erweiterung fuer nvent Workflow-Worker (initial path://, spaeter optional package://).
