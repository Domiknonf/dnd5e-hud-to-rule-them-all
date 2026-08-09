# A DnD 5e HUD To Rule Them All

A combat HUD for Foundry VTT that does two things at once: show every activity a creature
can actually use, grouped by action type — and track the action / bonus action / reaction
economy. Styled as a Baldur's Gate 3-like hotbar across the bottom of the screen.

**Foundry v13** · **dnd5e 5.x** · MIT · `0.4.0` (pre-alpha)

---

## Why another combat HUD

Existing HUDs are good at *listing* what a creature can do. They are much weaker at
answering the question that actually slows a table down: *have I already used my bonus
action this turn?*

This module treats the action economy as the primary feature and the button grid as the
thing wrapped around it.

Also most of the other ones just simply don't suit my parties needs, so I'm making this one.

## Features

- **Activity-aware action list.** Walks every activity on every item, not just items, so
  a weapon with an attack plus a utility activity shows up in both the action and the
  bonus action group.
- **Economy tracking.** Action, bonus action, reaction and legendary actions, tracked per
  combatant — including reactions spent on other creatures' turns.
- **One write path.** Costs are booked in `dnd5e.postUseActivity`, so a click in the HUD,
  a click on the character sheet, a macro and a Midi QoL workflow all count identically
  and none of them double-count.
- **Three enforcement levels.** Track silently, warn, or block the usage outright.
- **Extra Attack.** Several attacks share one action instead of each burning their own.
  The Dragonborn's Breath Weapon counts as one of those attacks, per the 2024 rules.
- **BG3-style bar.** Bottom-anchored hotbar with square icon slots, a portrait HP ring and
  per-pool markers. Collapses out of view when you need the screen. Foundry's own macro
  hotbar hides itself while it is up.
- **Descriptions in place.** Middle-click any slot to expand dnd5e's own item card above
  the bar, without opening a sheet or a window.
- **Passive features.** Feats with nothing to click (Weapon Mastery, Tactical Shift, …)
  get their own section as read-only reference cards.
- **Portrait shortcuts.** Click for the character sheet; at 0 HP it turns into a skull that
  rolls a death saving throw.

## Compatibility

| | Version |
| --- | --- |
| Foundry VTT | 13 (verified 13.351) |
| dnd5e system | 5.0.0+ (verified 5.3.3) |
| Dependencies | none |

Plays nicely alongside Midi QoL, DAE and Times Up. Can run in parallel with other combat
HUDs while you evaluate it.

## Install

Paste this manifest URL into Foundry's *Install Module* dialog:

```
https://github.com/Domiknonf/dnd5e-hud-to-rule-them-all/releases/latest/download/module.json
```

## Configuration

Settings live under *Configure Settings → Module Settings*.

**Rules** — pool sizes for action, bonus action and reaction.

**Enforcement** — `Track only`, `Warn`, or `Block the usage`, plus a GM bypass.

**Content filters** — hide unequipped gear, hide unprepared spells.

**Presentation** (per user) — HUD scale, sort order, visibility on other creatures' turns.

### Per character — the gear on the bar

Everything the module cannot know for certain is answered here rather than guessed at,
by whoever owns the character (the GM owns everyone).

- **Drag-and-drop zones** put an entry in a different pool, reorder it within one, or
  take it off the bar. The zones start out **seeded by detection**, so this is a
  correction surface — not a form you have to fill in before the bar works.
- **Attacks per Attack action** (Extra Attack), and pool sizes.
- **Multiattack editor** for what a single number cannot say: *"two Holy Bursts **or**
  three Radiant Swords"* is two alternatives, *"one bite **and** two claws"* is one
  alternative with two parts. Nothing asks which one is being taken — every
  alternative stays open until a use rules it out, and the badges show what is still
  allowed. It opens prefilled with the statblock's own reading.

Detection still runs, but only to prefill that dialog and as the fallback while
nothing has been configured — which is what keeps a freshly dropped pack of NPCs
usable without configuring six statblocks first. **Configuration always wins.**

When detection and configuration disagree — typically after a level-up — the gear gets
a mark and the dialog offers the change with the feature that caused it quoted by name.
It never rewrites a configured value on its own.

**English compendium content only.** The detection matches English SRD names and
statblock phrasing; translated or renamed content needs the dialog.

### What the bar tracks on its own

- **Opportunity Attacks.** Nothing in dnd5e marks one, so an action-cost activity used
  on somebody else's turn is booked as the Reaction it actually is.
- **Action Surge** and anything else configured to *grant* pool capacity.
- **Haste** and **Slow**, read off the effects of whoever has them.
- **Stunned, Paralyzed, Unconscious, Petrified, Incapacitated** bar the economy
  outright; the pips stay visible and struck through, so it reads as the condition
  rather than as a broken bar.

The GM can correct any pool by hand: click a pool to hand one pip back, right-click to
spend one.

## Public API

```js
const api = game.modules.get("dnd5e-hud-to-rule-them-all").api;

api.diagnose();                       // what the module believes about the selected token
api.getEconomy(combatant);            // { used, granted, max, attacksLeft, multiattack, log }
await api.spend(combatant, "bonus", { label: "Cunning Action" });
await api.refund(combatant);          // undoes the last booking
await api.resetTurn(combatant);

api.openConfig(actor);                // the gear dialog
api.openMultiattack(actor);           // the Multiattack editor
```

## Development

No build step. Plain ESM, Handlebars and CSS, loaded directly by Foundry.

```bash
git clone https://github.com/Domiknonf/dnd5e-hud-to-rule-them-all
ln -s "$(pwd)/dnd5e-hud-to-rule-them-all" \
  <foundry-data>/Data/modules/dnd5e-hud-to-rule-them-all
```

Then restart Foundry and enable the module. Code changes need only a browser reload;
changes to `module.json`, `lang/*.json`, or the file lists in `esmodules`/`styles` need a
server restart.

Releases are cut by pushing a tag — the workflow stamps `module.json` and publishes the
zip:

```bash
git tag v0.4.0 && git push --tags
```

## Roadmap

- [x] **M0** — scaffold, HUD renders for the active combatant
- [x] **M1** — economy correct across a full round, undo
- [x] **M3** — configurability: zones, filters, per-entry rules, per-actor overrides
- [ ] **M4** — parity: spell slots, item uses, concentration, targeting, Extra Attack
- [x] **M5** — BG3-style theming; keybindings and repositioning still open

Movement tracking (former **M2**), the generic intrinsic actions (Dash, Dodge, Hide, …)
and the Free Interaction pool shipped in early versions and were **deliberately removed**
again — they are not coming back.

## Acknowledgements

The activity-enumeration approach owes a lot to reading how Token Action HUD and Argon
solve the same problem. No code was copied from either.

## License

MIT. See `LICENSE`.
