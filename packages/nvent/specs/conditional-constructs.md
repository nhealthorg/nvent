# Conditional Constructs for defineWorkflow (`if` / `else`)

Status: Draft

Zweck
- Definiere eine `if`/`else`-Konstruktion für `defineWorkflow()` analog zu `loop`/`fanout`, die runtime‑evaluierbare Bedingungen unterstützt.
- Ziel: Entwickler schreiben lesbare Branch‑Logik in Workflows; Engine übersetzt in DAG‑Control‑Flow und evaluiert Bedingungen zur Laufzeit.

Design‑Prinzipien
- Bedingungen sind erst evaluiert, wenn alle referenzierten Node‑Outputs verfügbar sind.
- Bedingungen sind deklarativ serialisierbar (keine arbitrary JS‑Funktionen) und können Wert‑Refs (`node:`-Refs) oder Literale referenzieren.
- `if`/`else` erzeugen getrennte Sub‑DAGs; nur der gewählte Pfad wird zur Ausführung geplant.
- Ergebnis der `if` ist ein ValueRef auf das letzte Node‑Ergebnis des ausgeführten Pfads.

Developer API (Vorschlag)

- Signatur (High‑level):
```ts
// condition: ConditionExpr | WorkflowValueRef | boolean
// thenFn: (ctx) => any
// elseFn?: (ctx) => any
ctx.if(condition, thenFn, elseFn?)
```

- Helpers zum Erstellen von Bedingungen (aus `defineWorkflow` exportieren):
```ts
 - Helpers zum Erstellen von Bedingungen (als Teil des `ctx`, z. B. `ctx.cond`):
 ```ts
 // condition constructors (available via `ctx.cond` inside handlers)
 ctx.cond.eq(left, right)
 ctx.cond.ne(left, right)
 ctx.cond.gt(left, right)
 ctx.cond.gte(left, right)
 ctx.cond.lt(left, right)
 ctx.cond.lte(left, right)
 ctx.cond.and(...items)
 ctx.cond.or(...items)
 ctx.cond.not(item)
 // helper to reference nested properties of a value/ref
 ctx.cond.prop(valueRefOrLiteral, 'fieldName')
 // helper to reference the run input or named path: ctx.value('run_input') or ctx.value('foo.bar')
 ctx.value(path)
 ```

 - `left`/`right` können Literale oder `WorkflowValueRef` (z. B. das Ergebnis von `await ctx.call(...)`, das intern als `{ $ref: 'node:load' }` serialisiert wird). `ctx.value('run_input')` liefert eine ValueRef auf das Run‑Input (nutze `ctx.value('foo.bar')` für Pfadangaben).

Beispiele für Entwickler

1) Einfache If basierend auf `run_input` (nur TS‑Objekte / ValueRefs)
```ts
// innerhalb eines defineWorkflow handlers
const isMany = ctx.cond.gt(ctx.cond.prop(ctx.value('run_input'), 'count'), 10)
await ctx.if(isMany, async c => {
  await c.call('heavy', 'app::heavyProcess', ctx.value('run_input'))
})
```

2) If basierend auf vorherigem Node‑Output (ValueRef)
```ts
const a = await ctx.call('load', 'app::load', input) // a is a WorkflowValueRef
// check nested field 'size' on the returned object
const isBig = ctx.cond.gt(ctx.cond.prop(a, 'size'), 1000)
await ctx.if(isBig, async c => {
  await c.call('processLarge', 'app::processLarge', a)
}, async c => {
  await c.call('processSmall', 'app::processSmall', a)
})
```

3) Komplexe Bedingung (kombiniert mehrere Refs)
```ts
const a = await ctx.call('a', 'app::a', input)
const b = await ctx.call('b', 'app::b', input)
const condExpr = ctx.cond.and(
  ctx.cond.gt(a, 10),
  ctx.cond.lt(ctx.cond.prop(b, 'score'), 5)
)
await ctx.if(condExpr, async c => {
  await c.call('handle', 'app::handle', { a, b })
})
```

Semantik
- `ctx.if(condition, thenFn, elseFn?)`:
 - `ctx.if(condition, thenFn, elseFn?)`:
  - `condition` wird serialisiert in eine `ConditionExpr` und in die Node‑Spec geschrieben.
   - `condition` (ein JS‑Objekt gebaut via `ctx.cond` / `ctx.value`) wird serialisiert in eine `ConditionExpr` und in die Node‑Spec geschrieben. `defineWorkflow` erkennt diese Objekte — keine String‑Expressions.
  - Wird die Bedingung `true`, so wird das `thenFn`‑Subdag geplant/executed; andernfalls `elseFn` wenn vorhanden.
  - `if` erzeugt implizit keine dauerhaften Werte; `thenFn`/`elseFn` erzeugen Nodes wie üblich.
  - Rückgabe von `ctx.if` ist ein WorkflowValueRef `node:if:<id>:out` (oder des letzten Node im aktiven Pfad).

If ohne `else` (optional)
- Verhalten:
  - Ein `ctx.if(condition, thenFn)` ohne `else` ist vollständig unterstützt und bedeutet: Wenn `condition` wahr ist, wird der `then`‑Subdag geplant und ausgeführt; wenn `condition` falsch ist, wird kein Pfad ausgeführt und der `if`‑Bereich wird übersprungen.
  - Die Workflow‑Ausführung setzt danach normal mit den folgenden Nodes fort (der `if`‑Bereich blockiert nicht die Fortsetzung des Workflows außer durch normale Abhängigkeiten).
- Rückgabewert und Resolution:
  - `ctx.if(...)` gibt immer eine `WorkflowValueRef` zurück (`node:if:<id>:out`).
  - Falls der `then`‑Pfad ausgeführt wurde, wird die Referenz auf das Ergebnis des letzten Nodes dieses Pfads aufgelöst.
  - Falls kein Pfad ausgeführt wurde (kein `else` und Bedingung ist `false`), löst die Referenz auf `null` (kein Wert). Engines sollten dieses `null` explizit unterstützen und Events/Logs für `branch:skipped` emittieren.
- Observability / Events:
  - Engine emittiert mindestens `branch:condition_evaluated` (mit Ergebnis true/false) und `branch:skipped` wenn kein Pfad ausgeführt wurde.
- Empfehlung:
  - Wenn downstream Nodes ein Ergebnis erwarten, solltest du entweder ein `else` definieren oder das Fehlen eines Werts in einem nachfolgenden Node prüfen bzw. einen Default‑Node (`ctx.call('default', ...)`) verwenden.

Beispiele — If ohne `else`

1) Ausführung nur bei wahrer Bedingung
```ts
const data = await ctx.call('load', 'app::load', input)
const isBig = ctx.cond.gt(ctx.cond.prop(data, 'size'), 10)
const out = await ctx.if(isBig, async c => c.call('handleBig', 'app::handleBig', data))
// Wenn isBig true ist → out verweist auf `app::handleBig` Ergebnis
// Wenn isBig false ist → out resolves to null, Engine emittiert `branch:skipped`
```

2) Überspringen und normal fortfahren
```ts
await ctx.call('a', 'app::a', input)
await ctx.if(ctx.cond.eq(ctx.value('run_input.mode'), 'fast'), async c => {
  await c.call('fastPath', 'app::fast', ctx.value('run_input'))
})
// Dieser Node ist unabhängig vom if und läuft danach weiter
await ctx.call('b', 'app::b', input)
```

3) Fallback als Node statt `else`
```ts
const data = await ctx.call('load','app::load', input)
const isOk = ctx.cond.gt(ctx.cond.prop(data,'score'), 50)
const okRef = await ctx.if(isOk, async c => c.call('ok','app::ok', data))
// Falls okRef null ist, rufe einen Default‑Node auf
if (!okRef) {
  await ctx.call('fallback','app::fallback', data)
}
```

How it compiles (Engine representation)
- `defineWorkflow` kompiliert `ctx.if(...)` zu einem special nodeDef:
```json
{
  "id": "if:123",
  "type": "if",
  "condition": { /* serialized ConditionExpr */ },
  "then": { "nodes": { ... }, "output": { from: "nodeX" } },
  "else": { "nodes": { ... }, "output": { from: "nodeY" } }
}
```
- Alternativ kann Engine das `then`/`else` in-line in das global `nodes`-Objekt expandieren, dabei aber control dependencies so setzen, dass nur der ausgewählte Pfad exekutiert wird.

Evaluation
- Engine evaluiert `condition` zur Laufzeit auf dem Entscheidungs‑Knoten (nach Verfügbarkeit aller referenzierten Node‑Outputs).
- Engine muss sicherstellen, dass alle Nodes, die in der Condition referenziert werden, als Abhängigkeiten (`depends_on`) gesetzt sind.
- Condition‑Evaluator unterstützt comparison/logical operators; implementiert in Engine core (nicht in user code).

Mapping in `defineWorkflow.ts` (Änderungsvorschlag)
- `ctx.if` implementieren wie `ctx.loop`: erzeugt temporären parallelCollector/Frontier, kompiliert `thenFn` und `elseFn` in Sub‑Contexts.
- `collectNodeRefs` sollte ConditionExpr scannen und daraus `depends_on` ableiten.
- `nodeDef` für if enthält `condition` serialisiert und `thenNodeIds`/`elseNodeIds` (oder inline nodes).
 - `ctx.if` implementieren wie `ctx.loop`: erzeugt temporären parallelCollector/Frontier, kompiliert `thenFn` und `elseFn` in Sub‑Contexts.
 - `collectNodeRefs` sollte ConditionExpr (die `ctx.cond`/`ctx.value` Objekte) scannen und daraus `depends_on` ableiten.
 - `nodeDef` für if enthält das serialisierte `condition`-Objekt und `thenNodeIds`/`elseNodeIds` (oder inline nodes).

Edge Cases & Details
- Async Conditions: Bedingungen dürfen keine async Funktionen enthalten; zur Laufzeit referenzierende Node‑Outputs sind erlaubt.
- Side‑effects: Bedingung darf keine Seiteneffekte haben — alles Seiteneffekte müssen über Nodes modelliert sein.
- Multiple outputs: Wenn beide Pfade Nodes erzeugen unterschiedliche `output`-Nodes, `if` sollte einen unified `output.from` auf das aktive Pfad‑Output setzen (Engine intern).
- Parallelism: `if` Pfade können intern parallel sein; Engine schedules only chosen path.
- Nested conditionals: supported, compile to nested `if` nodes.

Observability
- Emit events: `branch:condition_evaluated` (result,true/false), `branch:entered` (then/else), `branch:skipped`.
- Provide Devtools UI: highlight chosen branch, show condition expression and evaluated values.

UI / Devtools representation
- Darstellung als spezialisierter Block:
  - `if`‑Konstrukte sollen in der Devtools‑UI als speziell designeter Block angezeigt werden (keine normale Gruppe/cluster wie bei `branch`). Der Block zeigt sichtbar die serialisierte `condition` (als lesbare AST/Label) und das ausgewertete Ergebnis (true/false) an.
  - Visuell: Der `if`‑Block enthält zwei Bereiche: `then` (links) und optional `else` (rechts). Wenn `else` nicht gesetzt ist, wird der rechte Bereich als "skipped"/leer dargestellt.
- Knoten‑Diagram / Overview:
  - Anders als ein generischer `branch` wird `if` als eigenständiger Node im globalen Node‑Diagram und in der Workflow‑Overview geführt. Das bedeutet:
    - Im Node‑Diagram erscheint ein einzelner `if:<id>`‑Node, der bei Expansion die intern kompilierten Sub‑Nodes (then/else) anzeigt oder inline expandiert.
    - In der Overview (high‑level view) sieht man den `if`‑Block als Verzweigungseinheit mit dem Condition‑Label und einer kurzen Zusammenfassung ("then: N nodes", "else: M nodes | absent").
- Laufzeit‑Hervorhebung:
  - Während einer Run‑Ausführung wird die UI die ausgewertete Bedingung hervorheben (z.B. grüner Rand bei true, grauer/ausgegrauter bei false) und den tatsächlich betretenen Pfad markieren. Bei `else`‑Absenz wird bei false das ganze `if`‑Block‑Innere als "skipped" markiert.
- Events & Logs in der UI:
  - Die UI soll die Events `branch:condition_evaluated`, `branch:entered` und `branch:skipped` darstellen, inklusive der Values, die zur Auswertung genutzt wurden (sofern vom Run‑Trace verfügbar).
- UX‑Verhalten:
  - Expand/Collapse: Der `if`‑Block lässt sich aufklappen, um die enthaltenen Nodes sichtbar zu machen; standardmäßig zeigt die Overview nur das `if`‑Node mit Condition‑Label.
  - Inline‑Result: Wenn die `if` ausgeführt wurde, erlaubt die UI, direkt zur Result‑Node des aktiven Pfads zu springen.


Error Handling
- If condition evaluation fails (type error, missing value), Engine should mark run as failed unless config says `onConditionError: 'false'|'fail'|'else'`.
- If selected branch fails, normal node error semantics apply.

Implementation roadmap (MVP)
1. Add `cond` helper constructors to runtime API and export from `defineWorkflow` utilities.
2. Implement `ctx.if` in `defineWorkflow.ts`: compile then/else into subcontexts, collect deps from condition and subnodes, produce `if` nodeDef (or inline expansion) with `condition`.
3. Engine: add `if` node executor: evaluate `condition` after deps available, schedule chosen subnodes, set run.output accordingly.
4. Tests: simple true/false conditions; conditions referencing node outputs; nested ifs; error cases.
5. Devtools: render condition and chosen branch.

Open Questions
- Syntax ergonomics for conditions (string expressions vs AST helpers). Recommendation: provide AST helper (`cond.*`) to keep serialization safe.
- Default when condition evaluation errors (fail vs else). Recommend `fail` for safety.

Beispiel‑Implementierung für Entwickler (complete)
```ts
export const wfConditional = defineWorkflow({
  name: 'wf-conditional',
  handler: async (input, ctx) => {
    const load = await ctx.call('load', 'app::load', input)

    const result = await ctx.if(
      cond.gt(load, 100),
      async c => {
        return c.call('big', 'app::processBig', load)
      },
      async c => {
        return c.call('small', 'app::processSmall', load)
      }
    )

    return result
  }
})
```

Wenn du möchtest, setzte ich die Änderungen in `packages/nvent/src/runtime/nitro/utils/defineWorkflow.ts` um (API + compile‑time serialization) und schreibe Engine‑Skizzen für die `if`-Node‑Ausführung. 
