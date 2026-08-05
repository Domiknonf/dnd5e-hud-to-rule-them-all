# Aktueller Stand — Übergabe an einen neuen Chat

Dieses Dokument ist so geschrieben, dass es allein ausreicht. Lade es in einen neuen Chat,
und wir können ohne Vorgeschichte weiterarbeiten.

---

## Was gebaut wird

Ein eigenes Foundry-VTT-Modul: **A DnD 5e HUD To Rule Them All**
(Modul-ID `dnd5e-hud-to-rule-them-all`, intern kurz `hudtra`).

Ein Combat HUD für D&D 5e, das drei Dinge gleichzeitig macht:

1. alle nutzbaren Aktivitäten einer Kreatur anzeigen, gruppiert nach Aktionstyp
2. die Aktions-Ökonomie tracken (Aktion, Bonusaktion, Reaktion, freie Interaktion, legendäre Aktionen)
3. die verbleibende Bewegung anzeigen

Das Ziel ist, langfristig Argon (Enhanced Combat HUD) zu ersetzen. **Wichtig:** Argon bleibt
aktiv, bis der eigene HUD Feature-Parität erreicht (Meilenstein M4). Zwei HUDs können
parallel laufen.

## Umgebung

| | |
| --- | --- |
| Repo | https://github.com/Domiknonf/dnd5e-hud-to-rule-them-all |
| Foundry VTT | 13 Stable, Build 351 |
| dnd5e System | 5.3.3 |
| Produktion | Foundry auf einem Hetzner VPS |
| Entwicklung | zweite lokale Foundry-Instanz, eigener `--dataPath`, Repo per Symlink eingehängt |
| Lizenz | erlaubt zweite Instanz ausdrücklich, solange nur der Lizenzinhaber darauf zugreift |

Relevanter Modul-Stack in der Produktionswelt (~40 Module): Midi QOL 13.0.64, DAE 13.0.29,
Times Up 13.1.9, libWrapper 1.13.5.1, socketlib 1.1.4, Argon Combat HUD CORE 4.1.2 /
DND5E 5.1.5, Carousel Combat Tracker 4.1.8, Plutonium 2.15.2. Die lokale Dev-Instanz läuft
bewusst mager: nur System plus eigenes Modul, Midi erst später dazu.

## Was bereits existiert

Ein lauffähiges Scaffold in Version 0.1.0, syntaktisch geprüft, aber **noch nicht in einer
laufenden Welt getestet**.

```
module.json                 Manifest, gepinnt auf v13.351 / dnd5e 5.3.3
CLAUDE.md                   Konventionen und Architektur für Claude Code
README.md                   öffentliche Doku
scripts/const.mjs           alle Laufzeit-Annahmen: Pools, Activation-Map, generische Aktionen
scripts/economy.mjs         State-Modell, einzige Stelle die das Economy-Flag schreibt
scripts/movement.mjs        leitet das Bewegungsbudget ab, speichert nichts
scripts/actions.mjs         sammelt Activities aus den Items des Actors
scripts/hud.mjs             ApplicationV2 plus Klick-Handler
scripts/socket.mjs          Relay für Spieler-Schreibzugriffe an den GM
scripts/module.mjs          nur Hook-Verdrahtung, keine Logik
templates/hud.hbs           Handlebars-Template
styles/hud.css              CSS in @layer modules, nutzt Foundrys CSS-Variablen
lang/en.json, lang/de.json  Lokalisierung
.github/workflows/release.yml  stempelt module.json beim Tag-Push und baut das Release
```

Kein Build-Step. Reines ESM, direkt von Foundry geladen.

## Architekturentscheidungen (bitte nicht neu aufrollen)

**1. Der State liegt in einem Flag am Combatant-Dokument.**
Key: `flags["dnd5e-hud-to-rule-them-all"].economy`. Combatant-Flags replizieren gratis zu
allen Clients und verschwinden mit dem Encounter. Haken: Spieler besitzen ihren Actor, aber
nicht den Combatant — ihre Schreibzugriffe laufen per Socket über den aktiven GM.
Geschrieben wird ausschließlich in `economy.mjs`.

**2. Bewegung wird abgeleitet, nie gespeichert.**
`Rest = Speed × (1 + Dash) − movementHistory.cost`. Foundry v13 führt die Bewegungshistorie
inklusive Geländekosten selbst und leert sie beim Zugbeginn
(`Combat#_clearMovementHistoryOnStartTurn`, plus `Combat#clearMovementHistories` seit
13.338). Kein eigener Zähler, der auseinanderläuft.

**3. Es gibt genau einen Schreibpfad für Kosten.**
Gebucht wird in `dnd5e.postUseActivity`. HUD-Buttons rufen ausschließlich `activity.use()`
auf. Dadurch zählen Klicks im Charakterbogen, Makros und Midi-Workflows identisch, und
nichts wird doppelt abgezogen. `dnd5e.preUseActivity` ist das Gate — `false` zurückgeben
blockt die Nutzung.

**Domänenmodell:** Seit dnd5e 4.x ist die Einheit die *Activity*, nicht das Item. Ein Item
kann mehrere Activities mit unterschiedlichen Aktivierungstypen tragen. Es wird also immer
über `item.system.activities` iteriert, nie über Items.

## Nächster Schritt: vier Annahmen verifizieren

Das ist die erste offene Aufgabe. In der Dev-Welt Kampf starten, Token wählen, Konsole
öffnen:

```js
Object.keys(CONFIG.DND5E.activityActivationTypes)   // stimmt ACTIVATION_MAP in const.mjs?
_token.document.movementHistory                     // gibt es das Feld .cost?
CONFIG.debug.hooks = true                           // feuert combatTurnChange wie erwartet?
game.combat.combatant.flags["dnd5e-hud-to-rule-them-all"]   // wird gebucht?
```

Diese vier Punkte sind defensiv codiert und bewusst in `const.mjs` bzw. `movement.mjs`
gebündelt, weil sie zwischen System- und Core-Releases driften können. Abweichungen sind
jeweils eine Zeile Anpassung.

## Bekannte Problemstellen

Jede braucht eine Design-Entscheidung, keine schnelle Korrektur:

- **Extra Attack.** Eine Angriffsaktion enthält mehrere Attack-Rolls, gebucht wird aber pro
  Activity-Nutzung — der zweite Angriff frisst also eine zweite Aktion. Braucht einen Zähler
  "Angriffe übrig innerhalb dieser Aktion" pro Zug. **Das ist der wichtigste offene Punkt.**
- **Reaktionen außerhalb des eigenen Zugs.** Wird korrekt getrackt, aber der HUD muss während
  fremder Züge sichtbar und auf andere Combatants umschaltbar bleiben.
- **Reaktion resettet bei eigenem Zugbeginn**, nicht am Rundenende. Gleiches gilt für
  legendäre Aktionen.
- **Verpasste Hooks.** Wenn der GM-Client einen Zugwechsel verpasst, findet kein Reset statt.
  Das Feld `key` im Flag hält `round:turn` als Aufhänger für einen künftigen Staleness-Guard.
- **Erzwungene Bewegung** (Thunderwave, Grapple-Drag) zählt in v13 gegen das Budget des Ziels.
- **Midi QOL** wrappt die Activity-Nutzung. Die dnd5e-Hooks feuern weiter, Reihenfolge aber
  einmal mit `CONFIG.debug.hooks` prüfen, bevor Midi-spezifische Hooks dazukommen.

## Roadmap

- **M0** — Scaffold, Modul lädt, HUD rendert für den aktiven Combatant ← *hier stehen wir*
- **M1** — Ökonomie über eine komplette Runde korrekt, manuelle Korrektur, Undo
- **M2** — Bewegungsleiste inkl. Dash und Bewegungsarten, optionaler Hard Stop
- **M3** — Konfigurierbarkeit: Layout, Filter, Regel-Toggles, Overrides pro Actor
- **M4** — Parität: Zauberplätze, Item-Uses, Konzentration, Zielauswahl, Extra Attack
- **M5** — Politur: Keybindings, Verschieben per Drag, Theming, Doku

Argon erst nach M4 abschalten.

## Konkrete To-dos

1. Vier Annahmen oben verifizieren, Abweichungen in `const.mjs` / `movement.mjs` einarbeiten
2. Testrunde mit Kämpfer (Stufe 5+, Extra Attack) und Schurke oder Mönch (Bonusaktion)
3. Extra-Attack-Zähler entwerfen und einbauen
4. Reset-Verhalten über eine volle Runde prüfen, inklusive übersprungener Combatants
5. HUD-Umschaltung auf andere Combatants, damit Reaktionen off-turn nutzbar sind
6. Erst danach Midi QOL lokal dazuinstallieren und Hook-Reihenfolge prüfen

## Womit du im neuen Chat einsteigen kannst

> Ich entwickle ein Foundry-v13-Modul für D&D 5e (dnd5e 5.3.3), einen Combat HUD mit
> Action-Economy- und Bewegungs-Tracking. Anbei der aktuelle Stand und das Repo. Ich stehe
> bei M0 und will als nächstes [den Extra-Attack-Zähler bauen / die vier Annahmen
> verifizieren / …].

Dazu dieses Dokument, `CLAUDE.md` und die betroffenen Dateien aus `scripts/` mitgeben. Die
drei Architekturentscheidungen oben sind der wichtigste Kontext — ohne die schlägt jeder
neue Chat als Erstes vor, den State auf dem Actor zu speichern oder einen eigenen
Bewegungszähler zu bauen.
