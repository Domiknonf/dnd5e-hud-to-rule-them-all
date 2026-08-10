# Testplan 0.4.0 — was am lebenden Objekt herausgefunden werden muss

Stand: Modul 0.4.0 läuft auf dem Produktions-Server (Foundry 13.351, dnd5e 5.3.3, 45 Module).

Dieses Dokument listet nur Fragen, die **durch Lesen des Codes nicht beantwortbar** sind: alles,
was von eurem Modul-Stack, eurem Content oder eurem Tisch abhängt. Jeder Findout sagt dazu,
**welche Zeile im Code sich ändert**, wenn die Antwort anders ausfällt als angenommen — Findouts
ohne Konsequenz stehen hier nicht drin.

Reihenfolge ist die Empfehlung: **P1** zuerst (zusammen ca. 25 Minuten, ohne Spieler),
**P2** braucht eine echte Kampfrunde, **P3** braucht einen zweiten Client oder eine Session.

---

## Ergebnisse

| Findout | Stand | Ergebnis |
| --- | --- | --- |
| F1 Aktivierungstypen | **erledigt** | Foundry 13.351 / dnd5e 5.3.3 / Modul 0.4.0 / Midi 13.0.64. 16 Typen, `UNBEKANNT: []` — `ACTIVATION_MAP` + `OUT_OF_COMBAT_ACTIVATIONS` decken alle ab, nichts fällt in `other`. Im Kommentar über `ACTIVATION_MAP` festgehalten. |
| F2–F15 | offen | |

---

## 0. Vorbereitung

- Konsole: **F12** → Tab *Console*. Alle Snippets sind in `(() => { … })()` gekapselt, also
  beliebig oft einfügbar, ohne dass „Identifier already declared" kommt.
- Der Tracer in F4 **patcht `Hooks.call`/`Hooks.callAll`**. Das ist ein reiner Konsolen-Eingriff,
  er überlebt kein F5 und wird mit `HUDTRA.stop()` sauber zurückgenommen. Trotzdem: **nicht
  während einer echten Session laufen lassen.**
- Zwei Einstellungen sind **welt-weit** (`enforceActions`, `gmBypass`) — Änderungen daran sehen
  auch die Spieler. Nach dem Test zurückstellen (Snippet in F7).
- Nach jedem Findout: Konsolen-Output mit `copy(…)` in die Zwischenablage holen und in die
  Rückmeldung kleben (Abschnitt 4). Chrome/Electron: `copy(HUDTRA.text())`.

Kurzcheck, dass die API da ist:

```js
game.modules.get("dnd5e-hud-to-rule-them-all")?.api
```

---

## 1. P1 — Umgebung und Content (ohne Kampf, ~10 Min)

### F1 — Stimmt `ACTIVATION_MAP` noch?

**Warum:** Ein Aktivierungstyp, den `const.mjs` nicht kennt und der nicht in
`OUT_OF_COMBAT_ACTIVATIONS` steht, landet stillschweigend im Pool `other` — der kostet nichts
und hat keine Pips. Der Eintrag ist dann sichtbar, aber ökonomisch unsichtbar. Ändert:
`ACTIVATION_MAP` in `scripts/const.mjs`.

```js
(() => {
  const M = "dnd5e-hud-to-rule-them-all";
  const gemappt = ["action","bonus","reaction","legendary","mythic","lair","crew","special"];
  const verworfen = ["minute","hour","day","month","year","shortRest","longRest","encounter","turnStart","turnEnd"];
  const alle = Object.keys(CONFIG.DND5E.activityActivationTypes ?? {});
  return {
    foundry: game.version,
    dnd5e: game.system.version,
    hudtra: game.modules.get(M)?.version,
    api: Object.keys(game.modules.get(M)?.api ?? {}),
    aktivierungstypen: alle,
    UNBEKANNT: alle.filter(t => !gemappt.includes(t) && !verworfen.includes(t)),
    midi: game.modules.get("midi-qol")?.version,
    dae: game.modules.get("dae")?.version,
    timesUp: game.modules.get("times-up")?.version
  };
})()
```

**Melden:** das ganze Objekt. `UNBEKANNT: []` ist das gute Ergebnis.

---

### F2 — Fällt euer Monster-Content durch die Erkennung?

**Warum:** Drei Content-Quellen mit drei Item-Formen: das offizielle PHB-Modul, *Tomb of
Annihilation* und **Plutonium** (5eTools-Import). Drei Annahmen hängen daran, und alle drei
sind an einem Feld festgemacht, das ein Import anders füllen kann:

- `isDescriptiveOnly()` verlangt `item.system.type.value === "monster"`. Stimmt das bei einem
  Plutonium-Monster nicht, wird **Multiattack zu einem anklickbaren Button**, der eine Aktion
  kostet, und die Attacken-Erkennung liefert nichts.
- `hideUnequipped` (Standard **an**) blendet alles mit `system.equipped === false` aus. Wenn
  importierte Monsterwaffen nicht als angelegt gelten, ist die Leiste bei dem Monster **leer**.
- Legendäre Pips kommen aus `system.resources.legact.max`. Kein Wert → kein Pool.

Ein Token wählen, dann (bitte **je einmal für ein PHB-Monster, ein ToA-Monster und ein
Plutonium-Monster**):

```js
(() => {
  const a = canvas.tokens.controlled[0]?.actor;
  if (!a) return "Bitte einen Token auswählen.";
  console.log("=== " + a.name + " (" + a.type + ") ===");
  console.table(a.items.map(i => ({
    Item: i.name,
    Typ: i.type,
    Untertyp: i.system?.type?.value ?? "",
    angelegt: i.system?.equipped ?? "-",
    Activities: [...(i.system?.activities ?? [])]
      .map(x => `${x.type}:${x.activation?.type ?? "-"}${x.activation?.override ? "*" : ""}`).join("  ")
  })));
  return {
    quelle: a._stats?.compendiumSource ?? "(unbekannt)",
    flagQuellen: Object.keys(a.flags ?? {}),
    legact: a.system?.resources?.legact ?? null,
    unangelegteWaffen: a.items.filter(i => i.type === "weapon" && i.system?.equipped === false).map(i => i.name)
  };
})()
```

**Melden:** Screenshot der Tabelle + das Rückgabeobjekt, pro Quelle einmal. Interessant ist vor
allem die Spalte **Untertyp** bei der Multiattack-Zeile (muss `monster` sein) und
`unangelegteWaffen` (muss leer sein).

---

### F3 — Liest die Multiattack-Erkennung euren Statblock-Text?

**Warum:** `suggestMultiattack()` sucht „macht *zwei* … *<Attackenname>*" mit maximal 20 Zeichen
Abstand und trennt Alternativen an `or`. 5eTools-Text ist anders formatiert als SRD-Text
(andere Enricher, teils `@item`-Links, teils gar keine). Ändert: die beiden Regexe in
`actions.mjs` (`suggestMultiattack`, `guessAttacksPerAction`).

```js
(() => {
  const a = canvas.tokens.controlled[0]?.actor;
  if (!a) return "Bitte einen Token auswählen.";
  const ma = a.items.find(i =>
    [...(i.system?.activities ?? [])].some(x => x.type === "utility")
    && /attack/i.test(i.system?.description?.value ?? ""));
  if (!ma) return "Kein Multiattack-artiges Feature gefunden.";
  return {
    item: ma.name,
    untertyp: ma.system?.type?.value,
    rohtext: (ma.system?.description?.value ?? "").slice(0, 600),
    angriffsButtons: a.items.filter(i =>
      [...(i.system?.activities ?? [])].some(x => x.type === "attack")).map(i => i.name)
  };
})()
```

Danach **Zahnrad im HUD → Multiattack-Editor öffnen** und vergleichen: Ist der Vorschlag das,
was der Statblock sagt? (Der Vorschlag wird nur angezeigt, nicht gespeichert — Dialog schließen
ohne Save lehnt ihn ab.)

**Melden:** `rohtext` + ein Satz, was der Editor vorgeschlagen hat. Gute Kandidaten zum Testen:
ein Monster mit „*or*" (Planetar, Drache), eines mit „*one bite and two claws*", eines mit nur
einem Angriff.

---

## 2. P1 — Midi QoL, der wichtigste Block (~15 Min)

Das ist der Teil, den ich am wenigsten aus dem Code ableiten kann. Bekannt und verifiziert ist
nur: beide dnd5e-Hooks feuern, in der richtigen Reihenfolge, und Midi benennt jede Activity in
„Midi Attack" um. **Unbekannt** ist alles über *Anzahl* und *Abbruchverhalten*.

### F4 — Der Tracer (einmal einfügen, läuft bis F5 oder `HUDTRA.stop()`)

```js
(() => {
  const M = "dnd5e-hud-to-rule-them-all";
  if (globalThis.HUDTRA?.stop) globalThis.HUDTRA.stop();
  const trace = [];
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const WATCH = /^(dnd5e\.(pre|post)UseActivity|midi-qol\.)/;
  const label = (x) => {
    const act = x?.activity ?? x;
    const item = act?.item ?? x?.item;
    return [item?.name, act?.type, act?.activation?.type].filter(Boolean).join(" / ");
  };
  const origCall = Hooks.call, origAll = Hooks.callAll;
  Hooks.call = function (hook, ...args) {
    if (!WATCH.test(hook)) return origCall.call(this, hook, ...args);
    const row = { ms: at(), hook, was: label(args[0]) };
    trace.push(row);
    row.ergebnis = origCall.call(this, hook, ...args);
    return row.ergebnis;
  };
  Hooks.callAll = function (hook, ...args) {
    if (WATCH.test(hook)) trace.push({ ms: at(), hook, was: label(args[0]) });
    return origAll.call(this, hook, ...args);
  };
  const onFlag = (doc, changed) => {
    const econ = changed?.flags?.[M]?.economy;
    if (!econ) return;
    trace.push({
      ms: at(), hook: ">> FLAG GESCHRIEBEN", was: doc.name,
      used: JSON.stringify(econ.used ?? {}), attacksLeft: econ.attacksLeft,
      multiattack: JSON.stringify(econ.multiattack ?? null),
      granted: JSON.stringify(econ.granted ?? {}), von: game.user.name
    });
  };
  Hooks.on("updateCombatant", onFlag);
  // Renderzähler für F14: die Instanz selbst umhängen, nicht den Render-Hook raten.
  const hud = game.modules.get(M)?.api?.hud;
  const origRender = hud?.render?.bind(hud);
  let renders = 0;
  if (hud && origRender) hud.render = (...a) => { renders++; return origRender(...a); };
  globalThis.HUDTRA = {
    trace,
    renders: () => renders,
    dump: () => { console.table(trace); return trace.length; },
    text: () => trace.map(r =>
      `${String(r.ms).padStart(6)}ms  ${r.hook}  ${r.was ?? ""}`
      + (r.ergebnis === false ? "   -> ABGEBROCHEN" : "")
      + (r.used ? `   used=${r.used} attacksLeft=${r.attacksLeft} ma=${r.multiattack}` : "")).join("\n"),
    clear: () => { trace.length = 0; renders = 0; return "geleert"; },
    stop: () => {
      Hooks.call = origCall; Hooks.callAll = origAll;
      Hooks.off("updateCombatant", onFlag);
      if (hud) delete hud.render;
      delete globalThis.HUDTRA; return "Tracer aus.";
    }
  };
  return "Tracer laeuft. HUDTRA.text() | .dump() | .renders() | .clear() | .stop()";
})()
```

### F5 — Wie viele Buchungen macht **ein** Midi-Angriff?

**Warum:** Das ist die tragende Entscheidung Nr. 2 (genau ein Schreibpfad). Wenn Midis
„Other"-Activity oder ein Premades-/MISC-onUse-Makro selbst `activity.use()` aufruft, feuert
`dnd5e.postUseActivity` ein **zweites Mal** und die zweite Buchung frisst eine ganze weitere
Aktion. Das wäre der teuerste denkbare Bug und ich kann ihn nicht ohne euren Stack sehen.

1. Kampf starten, Kämpfer-Token wählen, `HUDTRA.clear()`
2. **einen** Angriff über den HUD-Button, komplett durchklicken (Angriff + Schaden + Anwenden)
3. `copy(HUDTRA.text())`

Danach dasselbe für:
- denselben Angriff **über den Charakterbogen** statt über den HUD (muss identisch zählen)
- einen **Zauber mit Zauberplatz** (Feuerball)
- ein Item mit **Uses** (Heiltrank)
- eine Bonusaktion (Cunning Action Dash)

**Erwartet:** pro Nutzung genau **ein** `dnd5e.postUseActivity` und genau **ein**
`>> FLAG GESCHRIEBEN` mit `used.action` +1 (bzw. `attacksLeft` −1 bei der zweiten Attacke).

**Melden:** die vier Traces. Wenn irgendwo zwei `postUseActivity` stehen: bitte die Zeile mit
`was:` dazu — daraus sehe ich, welche Activity die zweite ist.

---

### F6 — Extra Attack / Multiattack über eine echte Runde

**Warum:** `spendAttack()` verlässt sich darauf, dass jeder Angriff ein eigenes
`postUseActivity` ist. Midi bündelt aber Angriff + Schaden in einem Workflow, und bei
mehreren Zielen/Zusatzangriffen (Gambit's Premades, MISC) ist unklar, was einzeln feuert.

- Kämpfer Stufe 5+ (Extra Attack): zwei Angriffe in einer Aktion — **eine** Aktions-Pip weg,
  Badge zählt 2 → 1 → 0.
- Dann ein dritter Angriff: der **muss** eine neue Aktion kosten (bzw. blocken).
- Monster mit konfiguriertem Multiattack: Alternativen durchklicken und schauen, ob die
  Badges der anderen Alternative korrekt zusammenschrumpfen.

Zwischendurch jederzeit:

```js
game.modules.get("dnd5e-hud-to-rule-them-all").api.diagnose()
```

**Melden:** `attacksLeft`, `multiattack`, `used` nach jedem Klick — oder einfach den Tracer-Text.

---

### F7 — Was passiert, wenn das Modul eine Nutzung **abbricht**?

**Warum:** Das Gate gibt in `dnd5e.preUseActivity` `false` zurück. dnd5e bricht damit sauber ab
— aber Midi wrappt `Activity#use`, Automated Animations / Sequencer / JB2A hängen an Midis
Workflow, und **Smart Target** greift ins Targeting. Offen ist, ob ein Abbruch Reste
hinterlässt: gespielte Animation, halbe Chatkarte, verbrauchter Zauberplatz, Konsolenfehler.
Falls ja, muss das Gate anders greifen (z. B. früher, oder Midi-spezifisch).

```js
(async () => {
  const M = "dnd5e-hud-to-rule-them-all";
  await game.settings.set(M, "enforceActions", "block");
  await game.settings.set(M, "gmBypass", false);
  return "Blockmodus AN. Aktion aufbrauchen, dann nochmal angreifen.";
})()
```

Aktion verbrauchen, dann eine zweite Aktion versuchen — einmal mit einem Angriff, einmal mit
einem Zauber mit Zauberplatz. Beobachten: Warnung sichtbar? Animation gespielt? Chatkarte da?
Zauberplatz weg? Fehler in der Konsole (rot)?

Danach **unbedingt zurückstellen**:

```js
(async () => {
  const M = "dnd5e-hud-to-rule-them-all";
  await game.settings.set(M, "enforceActions", "warn");
  await game.settings.set(M, "gmBypass", true);
  return "zurueck auf Standard (warn + GM-Bypass)";
})()
```

**Melden:** die vier Beobachtungen pro Fall + eventuelle rote Konsolenzeilen.

---

## 3. P2 — Effekte, Zustände, Runden (echte Kampfrunde)

### F8 — Wie heißen Haste und Slow in **eurem** Stack?

**Warum:** `EFFECT_POOL_BONUS`, `EFFECT_EXCLUSIVE_POOLS` und `EFFECT_BLOCKED_POOLS` matchen
**verankert** auf den englischen Effektnamen (`/^hast(e|ed)$/`). Bei euch kann der Effekt aus
vier Quellen kommen — dnd5e selbst, DAE, **Gambit's Premades**, **Midi Item Showcase** oder
**CPR** — und jede benennt anders („Haste", „Hasted", „Haste (Concentration)", „Spell: Haste").
Trifft das Muster nicht, passiert **gar nichts** und die Leiste sieht völlig normal aus.
Ändert: die drei Tabellen in `const.mjs` — je eine Zeile pro Schreibweise.

Effekt aufs Ziel legen (so wie ihr es im Spiel tut, nicht per Hand), dann auf dem Ziel:

```js
(() => {
  const d = game.modules.get("dnd5e-hud-to-rule-them-all").api.diagnose();
  return {
    effekteRoh: d.effects,
    effekteNormalisiert: d.effectsAsMatched,
    trefferHaste: d.matchedPoolBonus,
    trefferSlow: d.matchedExclusive,
    maxima: d.maxima,
    gekoppelt: d.coupledPools,
    gesperrt: d.blockedByCondition,
    statuses: d.statuses
  };
})()
```

Durchspielen: **Haste** (Aktions-Pip muss sofort auf 2 gehen, ohne Zugwechsel) → **Haste läuft
ab** (Times Up: Pip muss wieder verschwinden, ohne F5) → **Slow** (Aktion und Bonusaktion
gekoppelt, Reaktion gesperrt) → **Stunned/Paralyzed** (alle Pips durchgestrichen, Bar nennt den
Zustand).

**Melden:** je ein Objekt pro Effekt. `trefferHaste: []` bei aktivem Haste ist der Fund.

---

### F9 — Kommen Zustände als `statuses` an?

**Warum:** `BLOCKING_CONDITIONS` matcht auf `actor.statuses` (Foundry-Status-IDs), damit es
egal ist, wer den Zustand gesetzt hat. Bei euch setzen ihn **DAE**, **Active Auras**, **Aura
Effects**, **Active Token Effects** oder das Token-HUD — und ob dabei die *Rider*-Zustände
(Stunned → Incapacitated) mitkommen, ist Systemsache.

Zustand über jeden dieser Wege einmal setzen, dann:

```js
(() => {
  const a = canvas.tokens.controlled[0]?.actor;
  return { statuses: [...(a?.statuses ?? [])],
           effekte: a?.appliedEffects?.map(e => e.name) ?? [],
           gesperrt: game.modules.get("dnd5e-hud-to-rule-them-all").api.diagnose().blockedByCondition };
})()
```

**Melden:** die Status-IDs pro Setzweg. Wenn ein Weg keine ID liefert, brauche ich einen
zweiten Matcher (Effektname) für `blockedPools()`.

---

### F10 — Feuert `combatTurnChange` mit Carousel + Combat Booster sauber?

**Warum:** Der Reset hängt an genau diesem Hook, und zwar **nur auf dem aktiven GM-Client**.
**Carousel Combat Tracker** und **Combat Booster** ersetzen den Tracker und ändern Züge teils
per direktem `combat.update()`. Verpasster Hook = kein Reset = die Pips der Kreatur bleiben
leer, bis jemand von Hand zurücksetzt. Das `key`-Feld (`round:turn`) im Flag existiert genau als
Aufhänger für einen Staleness-Guard, den ich bauen würde, wenn hier etwas ausfällt.

```js
(() => {
  const seen = [];
  for (const h of ["combatStart","combatTurnChange","combatRound","updateCombat","deleteCombat"]) {
    Hooks.on(h, () => seen.push({
      hook: h, runde: game.combat?.round, zug: game.combat?.turn,
      dran: game.combat?.combatant?.name, zeit: new Date().toLocaleTimeString()
    }));
  }
  globalThis.HUDTRA_TURNS = seen;
  return "Zug-Logger laeuft. HUDTRA_TURNS ansehen, console.table(HUDTRA_TURNS)";
})()
```

Zwei volle Runden spielen, dabei mindestens einmal: einen Combatant **während** des Kampfes
hinzufügen, einen entfernen, einen Zug **zurückspringen**, und einmal **F5 auf dem GM-Client**
mitten in der Runde.

**Melden:** `console.table(HUDTRA_TURNS)` als Screenshot. Erwartet: genau ein
`combatTurnChange` pro Zugwechsel, und nach dem F5 immer noch Resets.

---

### F11 — Reaktion außerhalb des eigenen Zuges, mit Midis Reaktions-Automatik

**Warum:** `poolForNow()` macht aus einer Aktion außerhalb des eigenen Zuges eine Reaktion —
das ist das einzige Signal, das es gibt. Midi fragt Reaktionen aber über einen **eigenen Dialog
auf dem Client des Besitzers** ab, und es ist offen, ob `postUseActivity` dort feuert und auf
wessen Client gebucht wird.

Während ein Monster dran ist: Gelegenheitsangriff eines Spielercharakters, und einmal Hellish
Rebuke o. ä. über Midis Reaktionsabfrage. Auf dem Client desjenigen, der reagiert:

```js
(() => {
  const d = game.modules.get("dnd5e-hud-to-rule-them-all").api.diagnose();
  return { dran: d.isTheirTurn, aktionKostetJetzt: d.actionCostsNow, verbraucht: d.used };
})()
```

**Erwartet:** `aktionKostetJetzt: "reaction"`, nach dem Gelegenheitsangriff `used.reaction: 1`
und `used.action: 0`, und **kein** `attacksLeft` (ein OA eröffnet keine Angriffsaktion).

**Melden:** Objekt vor und nach dem OA + Tracer-Text.

---

## 4. P3 — Spieler, Koexistenz, Last

### F12 — Was macht ein echter Spieler-Client?

**Warum:** Spieler besitzen ihren Actor, aber typischerweise nicht den Combatant — dafür gibt es
den GM-Relay in `socket.mjs`. Foundry leitet `Combatant#testUserPermission` allerdings an den
Actor weiter, d. h. möglicherweise schreiben Spieler direkt und der Relay ist toter Code (den
ich dann vereinfachen kann) — oder eben nicht, dann muss ich ihn härten (aktuell ohne ACK).

Auf dem **Spieler-Client** (zweiter Browser / privates Fenster):

```js
(() => {
  const M = "dnd5e-hud-to-rule-them-all";
  const c = game.combat?.combatants.find(x => x.actor?.isOwner);
  return {
    spieler: game.user.name,
    combatant: c?.name,
    isOwner: c?.isOwner,
    darfFlagSchreiben: game.user.isGM || c?.testUserPermission?.(game.user, "OWNER") === true,
    aktiverGM: game.users.activeGM?.name ?? "KEINER",
    diagnose: game.modules.get(M).api.diagnose()
  };
})()
```

Danach als Spieler: angreifen, Bonusaktion nutzen, das Zahnrad öffnen und eine Regel per
Drag & Drop setzen, „Zug beenden" drücken.

**Melden:** das Objekt + ob die Leiste beim Spieler **die eigene** Kreatur zeigt, während ein
Monster dran ist (das ist die Absicht), und ob die Pips beim Spieler ohne F5 aktualisieren.

---

### F13 — Argon, Carousel, Dice Tray: wer sitzt wem auf dem Kopf?

**Warum:** Die Leiste ist `position: fixed; bottom: 0; z-index: 60` und blendet `#hotbar` aus,
solange sie **ausgefahren** ist. Argon (CORE 4.1.2 + DND5E 5.1.5) sitzt ebenfalls unten und
blendet die Makroleiste ebenfalls aus. Solange beide parallel laufen sollen (bis M4), muss ich
wissen, ob das kollidiert und in welche Richtung ich ausweichen muss.

```js
(() => [...document.querySelectorAll("body > *, #interface > *")]
  .map(e => ({
    id: e.id || "(kein)",
    klasse: String(e.className ?? "").slice(0, 50),
    z: getComputedStyle(e).zIndex,
    pos: getComputedStyle(e).position,
    abstandUnten: Math.round(window.innerHeight - e.getBoundingClientRect().bottom)
  }))
  .filter(r => r.abstandUnten < 300))()
```

**Melden:** Tabelle + ein Screenshot mit beiden HUDs an. Interessant ist auch der
Wiederaufklapp-Reiter unten rechts (`.hudtra-reopen`) gegenüber **Dice Tray**.

---

### F14 — Last: wie oft rendert die Leiste?

**Warum:** Jedes `updateActor` rendert neu (60 ms Debounce). Ein Feuerball auf acht Token,
Midi-Schadensanwendung, Active Auras und **Prime Performance** im selben Stack — ich will
wissen, ob die Debounce reicht oder ob ich auf „nur rendern, wenn der Subjekt-Actor betroffen
ist" umbauen muss.

Mit laufendem Tracer (F4): `HUDTRA.clear()`, dann Feuerball auf möglichst viele Token,
Schaden anwenden, danach:

```js
({ renders: HUDTRA.renders(), kampfteilnehmer: game.combat?.combatants.size })
```

**Melden:** Zahl + subjektiv: ruckelt es?

---

### F15 — Lair Actions (relevant für *Tomb of Annihilation*)

**Warum:** `ACTIVATION_MAP` schiebt `lair` in den **legendären** Pool. Eine Lair Action zieht
damit eine legendäre Pip ab, obwohl sie regeltechnisch nichts damit zu tun hat. Falls ihr Lair
Actions benutzt, ist das ein echter Modellierungsfehler und braucht entweder einen eigenen Pool
oder Kostenfreiheit.

Prüfen an einem Monster mit Lair Actions: Wie sind die im Statblock modelliert (`activation.type`
aus F2), und passiert beim Nutzen etwas mit den Kronen-Pips?

**Melden:** ja/nein „wir nutzen Lair Actions" + der `activation.type`, den sie tragen.

---

## 5. Produkt-Findouts (während der Session mitschreiben, kein Code)

Das sind die Fragen, die entscheiden, **was ich als Nächstes baue** — Antworten in einem Satz
reichen:

1. **Wofür greifst du im Kampf noch zu Argon?** (Zauberplätze, Item-Uses, Konzentration,
   Zielauswahl, Bewegung?) Das ist die Prioritätenliste für M4, direkt aus der Praxis.
2. **Hat `warn` genervt oder geholfen?** Wäre `block` am Tisch realistisch, oder muss es eine
   Rolle-abhängige Einstellung werden (Spieler blocken, GM nicht)?
3. **Wie oft hast du das Zahnrad geöffnet, und wonach hast du dort gesucht?** Alles, was du
   dort erwartet und nicht gefunden hast, ist ein fehlendes Feld — die Regel im Repo lautet
   „lieber ein Feld im Dialog als eine neue Heuristik".
4. **Ist die Leiste bei den Spielern jemals als „falsche Kreatur" aufgefallen?** Die Regel ist:
   ausgewählter Token gewinnt, sonst der eigene Charakter, nie die aktive Kreatur.
5. **Hat jemand eine Buchung von Hand korrigieren müssen** (GM-Rechtsklick auf eine Pip), und
   warum? Jede Korrektur ist ein Fall, den die Automatik falsch gesehen hat.
6. **Fehlt etwas an der Ökonomie selbst?** Konzentration, legendäre Widerstände, Ladungen von
   Gegenständen als eigene Zeile?

---

## 6. Rückmeldeformat

Am schnellsten für mich: pro Findout eine Zeile plus Konsolen-Output, roh, ungefiltert.

```
F1  OK          <Objekt>
F2  PHB ok, Plutonium: Untertyp ist "" statt "monster"   <Objekt>
F5  ZWEI postUseActivity bei Angriff mit MISC-Makro      <Trace>
F8  Haste heisst bei uns "Hasted (Concentration)"        <Objekt>
...
```

Für den Trace reicht `copy(HUDTRA.text())` und einfügen. Screenshots nur da, wo es um Optik
geht (F13) oder eine `console.table` (F2, F10).

Am Ende der Tests:

```js
HUDTRA?.stop()
```

---

## 7. Was ich mit den Antworten mache

| Findout | Wenn die Antwort abweicht, ändere ich |
| --- | --- |
| F1 | `ACTIVATION_MAP` / `OUT_OF_COMBAT_ACTIVATIONS` in `const.mjs` |
| F2 | `isDescriptiveOnly()`-Shape-Test, ggf. `hideUnequipped`-Standard für NPCs |
| F3 | die beiden Text-Regexe in `actions.mjs` |
| F5 | tragende Entscheidung 2: Deduplizierung im Buchungspfad (`module.mjs`) |
| F6 | `spendAttack()` / `viableOptions()` |
| F7 | Ort des Gates — ggf. früher als `preUseActivity` |
| F8/F9 | die drei Effekt-Tabellen in `const.mjs`, ggf. zweiter Matcher |
| F10 | Staleness-Guard über das `key`-Feld im Economy-Flag |
| F11 | `poolForNow()` bzw. wo gebucht wird, wenn Midi remote ausführt |
| F12 | `socket.mjs` — härten oder entfernen |
| F13 | CSS-Position und `z-index` in `hud.css` |
| F14 | Render-Filter in `refreshHUD()` statt reiner Debounce |
| F15 | eigener Pool für `lair` in `RESOURCES` |
