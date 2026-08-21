# A DnD 5e HUD To Rule Them All

A combat HUD for Foundry VTT that does two things at once: show every activity a creature
can actually use, grouped by action type — and, for the creatures your players control,
track the action / bonus action / reaction economy. Styled as a Baldur's Gate 3-like
hotbar across the bottom of the screen.

**Foundry v13** · **dnd5e 5.x** · MIT · `0.7.2` (pre-alpha)

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
- **Economy tracking, for the creatures somebody plays.** Action, bonus action, reaction
  and legendary actions, tracked per combatant — including reactions spent on other
  creatures' turns. A creature only the GM owns is **not** counted: it gets the same bar,
  the same groups and the same per-pool configuration, just no pips. See
  [Who gets counted](#who-gets-counted).
- **One write path.** Costs are booked in `dnd5e.postUseActivity`, so a click in the HUD,
  a click on the character sheet, a macro and a Midi QoL workflow all count identically
  and none of them double-count.
- **Three enforcement levels.** Track silently, warn, or block the usage outright.
- **Extra Attack.** Several attacks share one action instead of each burning their own.
  The Dragonborn's Breath Weapon counts as one of those attacks, per the 2024 rules.
- **BG3-style bar.** Bottom-anchored hotbar with square icon slots, a portrait HP ring and
  per-pool markers. Collapses out of view when you need the screen. Foundry's own macro
  hotbar hides itself while it is up.
- **Two layouts, decided by ownership.** A creature somebody plays gets a BG3-style
  hotbar: one grid of slots with the empty ones drawn in, the action cost as a marker on
  each slot, category tabs above it and `+`/`-` for how many rows you want. A creature
  only the GM owns keeps the auto-grouped columns — nobody arranges twelve goblins by
  hand. A chain-pact imp or a summoned drake counts as played, because someone plays it.
- **Sections you can fold away** (GM layout). A crowded group is split into Weapons, Spells,
  Features, Consumables and Gear. Click a group's name to fold the whole thing, or one of
  the chips beside it to fold a single section — a folded chip names what it is holding
  and how much of it. Remembered per user. Passives start folded.
- **Spell slots, next to the pips.** One row per spell level with a pip per slot, so you
  see what is left without reading a number. Pact Magic gets its own row. Spells you have
  no slot left for grey themselves out — upcasting counted, cantrips and at-will casting
  never — so "can I still cast this" is answered before you ask. Spells sort by level,
  cantrips first.
- **Nothing moves.** The bar has a fixed width, so folding a section, filtering by level
  or switching creatures never slides the buttons out from under your pointer.
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

**Presentation** (per user) — HUD scale, sort order, and whether crowded groups are split
into sections. Which groups and sections you have folded away is remembered per user and
is set by clicking the bar itself, not in this menu.

### Who gets counted

The bar exists to help the person playing a creature keep track of what it can still
do. That person is not the GM, who already knows a goblin has one action and reads its
Multiattack off the statblock in front of them — so **only creatures with a player owner
have an action economy.** Everything else about the bar is identical either way.

| | Player-owned | GM-only |
| --- | --- | --- |
| Ability list, grouped by pool | yes | yes |
| Which pool an entry belongs to (gear dialog) | yes | yes |
| Legendary / reaction / bonus action **sections** | yes | yes |
| Pips, booking, enforcement, Extra Attack counting | yes | — |

It is an **ownership** question, not an `actor.type` one: a wildshaped druid, a summoned
drake and a sidekick are all `npc` actors that somebody plays, and those keep their
economy. Hand a boss monster to a player and it starts counting; take it back and it
stops.

If that is not what your table wants — or you are testing on a GM-owned character and
wondering where the pips went — *Count creatures without a player owner* turns counting
back on for everything. Off by default.

### Per character — the gear on the bar

Everything the module cannot know for certain is answered here rather than guessed at,
by whoever owns the character (the GM owns everyone).

- **Drag-and-drop zones** put an entry in a different pool, reorder it within one, or
  take it off the bar. The zones start out **seeded by detection**, so this is a
  correction surface — not a form you have to fill in before the bar works. Available
  for every creature, counted or not: this is how the GM's own bar gets organised.
- **Attacks per Attack action** (Extra Attack), and pool sizes. Counted creatures only —
  on a GM-only creature these do nothing, so they are not shown. Anything already stored
  is kept, and comes back if the creature is handed to a player later.

Detection still runs, but only to prefill that dialog and as the fallback while nothing
has been configured. **Configuration always wins.**

When detection and configuration disagree — typically after a level-up — the gear gets
a mark and the dialog offers the change with the feature that caused it quoted by name.
It never rewrites a configured value on its own.

**English compendium content only.** The detection matches English SRD feature names;
translated or renamed content needs the dialog.

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
api.getEconomy(combatant);            // { used, granted, max, attacksLeft, log }
await api.spend(combatant, "bonus", { label: "Cunning Action" });
await api.refund(combatant);          // undoes the last booking
await api.resetTurn(combatant);

api.openConfig(actor);                // the gear dialog
```

`diagnose()` leads with `tracked`. If that is `false`, nothing below it is meant to
have a value — the creature has no player owner and is not being counted.

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
git tag v0.7.2 && git push --tags
```

## Roadmap

- [x] **M0** — scaffold, HUD renders for the active combatant
- [x] **M1** — economy correct across a full round, undo
- [x] **M3** — configurability: zones, filters, per-entry rules, per-actor overrides
- [ ] **M4** — parity: spell slots, item uses, concentration, targeting, Extra Attack
- [x] **M5** — BG3-style theming; keybindings and repositioning still open

Movement tracking (former **M2**), the generic intrinsic actions (Dash, Dodge, Hide, …)
and the Free Interaction pool shipped in early versions and were **deliberately removed**
again — they are not coming back. Neither is the **Multiattack editor**, dropped in 0.5.0
along with the economy on GM-run creatures: it existed to describe monsters, and monsters
are no longer counted. Every heuristic that read statblock prose went with it.

## Acknowledgements

The activity-enumeration approach owes a lot to reading how Token Action HUD and Argon
solve the same problem. No code was copied from either.

## License

MIT. See `LICENSE`.
