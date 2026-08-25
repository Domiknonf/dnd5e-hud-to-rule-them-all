# A DnD 5e HUD To Rule Them All

A combat HUD for Foundry VTT that does two things at once: show every activity a creature
can actually use, grouped by action type — and, for the creatures your players control,
track the action / bonus action / reaction economy. Styled as a Baldur's Gate 3-like
hotbar across the bottom of the screen.

**Foundry v13** · **dnd5e 5.x** · MIT · `1.0.0`

---

## Why another combat HUD

Existing HUDs are good at *listing* what a creature can do. They are much weaker at
answering the question that actually slows a table down: *have I already used my bonus
action this turn?*

This module treats the action economy as the primary feature and the button grid as the
thing wrapped around it.

Also most of the other ones just simply don't suit my parties needs, so I'm making this one.

## How it works

**The bar is always there.** It is not tied to combat: it renders whenever there is
somebody to show, and only closes when there is nobody. Starting an encounter pulls it
up, ending one slides it away — the handle in the bottom-right corner brings it back by
hand at any time. Foundry's own macro hotbar hides itself while the bar is up and returns
the moment you collapse it.

**It shows exactly one creature, and never one you do not own.** Each client picks its
own subject. A token *you* selected wins over everything else — provided you own its
actor, which for a player is the only kind Foundry lets them select anyway. With nothing
selected, the GM falls back to whoever is currently acting; a player falls back to their
own character, or to whichever of their creatures is in the fight if they have none
assigned. A player's bar is therefore always one of theirs. It never follows the turn
pointer onto the acting monster, which used to fill their bar with a goblin's ability
list at exactly the moment their own reaction pip mattered.

**Buttons come from activities, not items.** In dnd5e 4.x+ the unit of "a thing you do"
is an Activity, and one item can carry several with different costs. A Net whose attack
is an action and whose utility is a bonus action is therefore two buttons, in two places,
because that is what it actually is. An item whose activities all agree stays one button
that opens dnd5e's own activity picker.

**Clicking a button just uses the thing.** The HUD never books a cost itself. Costs are
booked in `dnd5e.postUseActivity`, which means a click here, a click on the character
sheet, a macro and a Midi QoL workflow all count identically — and none of them
double-count. Turn the bar off mid-session and your sheet still counts correctly.

**What it cannot know for certain, it asks.** Which pool an odd feature belongs to, how
many attacks your Attack action grants, how big a pool is — all of that is answered once
in the gear dialog, by whoever owns the character. Detection still runs, but only to
prefill that dialog and as the fallback until you correct it. Configuration always wins,
and nothing is ever silently rewritten behind your back.

## Features

- **Activity-aware action list.** Walks every activity on every item, not just items, so
  a weapon with an attack plus a utility activity shows up in both the action and the
  bonus action group. An item that lands in two pools is marked as such, and the hover
  card names the other place it lives.
- **Economy tracking, for the creatures somebody plays.** Action, bonus action, reaction
  and legendary actions, tracked per combatant — including reactions spent on other
  creatures' turns. A creature only the GM owns is **not** counted: it gets the same bar,
  the same groups and the same per-pool configuration, just no pips. See
  [Who gets counted](#who-gets-counted).
- **One write path.** Costs are booked in `dnd5e.postUseActivity`, so a click in the HUD,
  a click on the character sheet, a macro and a Midi QoL workflow all count identically
  and none of them double-count.
- **Three enforcement levels.** Track silently, warn, or block the usage outright.
- **Extra Attack.** Several attacks share one action instead of each burning their own,
  with the attacks left in the current action shown on the slot. The Dragonborn's Breath
  Weapon counts as one of those attacks, per the 2024 rules.
- **Two layouts, decided by ownership.** A creature somebody plays gets a BG3-style
  hotbar: one grid of slots with the empty ones drawn in, the action cost as a marker on
  each slot, category tabs above it and `+`/`-` for how many rows you want. A creature
  only the GM owns keeps the auto-grouped columns — nobody arranges twelve goblins by
  hand. A chain-pact imp or a summoned drake counts as played, because someone plays it.
- **Arrange the bar by dragging its icons.** Drop an icon on another and the two trade
  places; drop it on an empty cell and it moves there, leaving the gap you made on
  purpose intact. Let go outside the bar and it offers to take that button off it. The
  gear dialog has a *Reset order* button that undoes the lot.
- **Category tabs** (played layout). *All* leads the strip, then Weapons, Spells,
  Features, Consumables, Gear and Passives — only the ones this creature actually has
  something in. Clicking the lit tab widens the grid again.
- **Sections you can fold away** (GM layout). A crowded group is split into Weapons, Spells,
  Features, Consumables and Gear. Click a group's name to fold the whole thing, or one of
  the chips beside it to fold a single section — a folded chip names what it is holding
  and how much of it. Remembered per user. Passives start folded.
- **Spell slots, next to the pips.** One row per spell level with a pip per slot, so you
  see what is left without reading a number. Pact Magic gets its own row. Spells you have
  no slot left for grey themselves out — upcasting counted, cantrips and at-will casting
  never — so "can I still cast this" is answered before you ask. Spells sort by level,
  cantrips first.
- **Everything a slot needs to say, on the slot.** Its pool as a coloured marker,
  remaining charges, attacks left inside the current action, and a link-slash when the
  item has a second button elsewhere. Each badge owns its own corner, so a Breath Weapon
  really can show all of them at once.
- **Nothing moves.** The bar has a fixed width, so folding a section, switching tabs or
  switching creatures never slides the buttons out from under your pointer.
- **Descriptions, pinned.** Middle-click any slot (or left-click a passive) to pin
  dnd5e's own item card — the same card the character sheet shows — beside the button.
  It floats above everything, so no sheet covers it and the bar costs no height for it.
  Click the card, middle-click the slot again, or switch creature to dismiss it.
- **Passive features.** Feats with nothing to click (Weapon Mastery, Tactical Shift, …)
  get their own tab or section as read-only reference cards.
- **Portrait shortcuts.** Click for the character sheet; at 0 HP it turns into a skull that
  rolls a death saving throw. The ring around it is the HP gauge.

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
into sections. How many rows the grid has, and which groups and sections you have folded
away, are remembered per user and are set by clicking the bar itself, not in this menu.

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

Configuration is stored on the base actor, so five unlinked goblins from one prototype
share it instead of needing five identical dialogs.

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
- **Haste** and **Slow**, read off the effects of whoever has them. Slow couples the
  action with the bonus action — either, not both — and bars reactions outright.
- **Stunned, Paralyzed, Unconscious, Petrified, Incapacitated** bar the economy
  outright; the pips stay visible and struck through, so it reads as the condition
  rather than as a broken bar.

The GM can correct any pool by hand: click a pool to hand one pip back, right-click to
spend one. There is also a *Reset turn* button that refills everything.

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

`node tools/verify.mjs` checks the things a syntax check cannot see: that every template
part renders a single root element, that no `data-action` is wired to nothing, that the
imports stay acyclic and that the i18n keys line up.

Releases are cut by pushing a tag — the workflow stamps `module.json` and publishes the
zip:

```bash
git tag v1.0.0 && git push --tags
```

## Status

1.0 covers what the module set out to do: the ability list, the economy behind it, the
two layouts, and enough configuration that nothing has to be guessed at twice.

**Deliberately not here, and not coming back.** Movement tracking, the generic intrinsic
actions (Dash, Dodge, Hide, …) and the Free Interaction pool all shipped in early
versions and were removed again. So was the **Multiattack editor**, dropped in 0.5.0
along with the economy on GM-run creatures: it existed to describe monsters, and monsters
are no longer counted. Every heuristic that read statblock prose went with it — if a
counted creature needs a number, it gets a field in the dialog instead.

**Not there yet.** Concentration, targeting, keybindings, moving the bar somewhere other
than the bottom edge, and any language but English.

## Acknowledgements

The activity-enumeration approach owes a lot to reading how Token Action HUD and Argon
solve the same problem. No code was copied from either.

## License

MIT. See `LICENSE`.
