## Project Todos

BUGS:
 - loops können keine arrays in geschachtelten objekten übernehmen, also die übergabe der variable im defineWorkflow handler kann kein pfad element übernehmen: ctx.loop(data.items,...)
 - Fehlermeldungen in der UI müssen kopierbar werden
 - workflow ctx.logger kann objekte loggen, diese haben keine begrenzung -> müssen truncated sein
 - ctx.loop kann aktuell zwei modi durchführen: sequentiell und parallel. Für große schleifen wäre aber batch noch ein wichtiger modus.
 - loops die parallel laufen, hier wird der status in der ui nicht korrekt angezeit. man weiß nicht wieviele loops schon gelaufen sind usw. liegt glaube ich daran, dass die loops nicht nach einer logischen reihenfolge ausgeführt werden, evtl fifo würde es regeln. aber es sollte auch ohne fifo in der ui besser laufen
 - paralleler loop hat zu fehlern geführt, weiß nicht warum genau

- [x] Document optional `else` behavior in `packages/nvent/specs/conditional-constructs.md`
- [ ] Implement optional-else handling in `defineWorkflow` / Engine — see [packages/nvent/specs/conditional-constructs.md](packages/nvent/specs/conditional-constructs.md)
- [ ] Implement UI/Devtools representation for `if` blocks — see [packages/nvent/specs/conditional-constructs.md](packages/nvent/specs/conditional-constructs.md)
 - [ ] Implement workflow result handling (memory-first) — see [packages/nvent/specs/workflow-result-handling.md](packages/nvent/specs/workflow-result-handling.md)



