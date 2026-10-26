# A DnD 5e HUD To Rule Them All

A combat HUD for Foundry VTT that does two things at once: show every activity a creature
can actually use, grouped by action type — and, for the creatures your players control,
track the action / bonus action / reaction economy. Styled as a Baldur's Gate 3-like
hotbar across the bottom of the screen.

**Foundry v13** · **dnd5e 5.x** · MIT · `1.4.0`

<!-- HERO SHOT - drop the file in and delete the comment markers around the line below.
     Wanted: a player character's bar mid-combat, at the default scale. The whole frame:
     portrait with its HP ring, the pip row, the spell slots, the category tabs and a
     grid with a few empty cells left in it. This is the one image that decides whether
     anybody reads the rest.
![The bar during a player character's turn](docs/images/hero.png)
-->

---

## Why another combat HUD

Existing HUDs are good at *listing* what a creature can do. They are much weaker at
answering the question that actually slows a table down: *have I already used my bonus
action this turn?*

This module treats the action economy as the primary feature and the button grid as the
thing wrapped around it.

Also most of the other ones just simply don't suit my parties needs, so I'm making this one.

## What it looks like

<!-- Each shot is its own comment block: to publish one, delete the `<!--` line above
     it and the `-->` line below it. They stand alone, so there is no need to do all
     three at once. Files go in docs/images/, which the release workflow does not pack
     into module.zip. -->

<!-- A MONSTER'S BAR, to show that a statblock gets the same hotbar a character does -
     ideally a legendary creature, so the legendary marker is on some of the slots.
![The same bar for a GM-run creature, with no economy counted](docs/images/bar-gm.png)
-->

<!-- THE GEAR DIALOG, which is where the module stops guessing: the drag-and-drop zones
     with entries in them, and at least one tile carrying its "overridden" mark.
![The per-character dialog: drag an entry into the pool it belongs to](docs/images/gear-dialog.png)
-->

<!-- A PINNED DESCRIPTION, because it is the feature nobody expects: a middle click on
     a slot, with dnd5e's own item card floating beside it over the bar.
![Middle-click a slot to pin dnd5e's own item card beside it](docs/images/description-card.png)
-->

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
- **Targets from the activity itself.** A click reads what the activity is aimed at —
  *Self*, *1 creature within 60 ft*, *up to three creatures*, an area — and acts on it:
  self effects target your own token, single and multi targets get a picker with what
  is in range, areas target whatever the placed template covers. See
  [How a click picks its targets](#how-a-click-picks-its-targets).
- **Extra Attack.** Several attacks share one action instead of each burning their own,
  with the attacks left in the current action shown on the slot. The Dragonborn's Breath
  Weapon counts as one of those attacks, per the 2024 rules.
- **A bar that is always there.** Bottom-anchored hotbar of square icon slots, and not
  tied to combat: it renders whenever there is somebody to show. Starting an encounter
  pulls it up, ending one slides it away, and the handle in the bottom-right corner
  brings it back by hand. Foundry's own macro hotbar hides itself while the bar is up
  and returns the moment you collapse it.
- **You only ever see your own creatures.** Each client picks its own subject: a token
  you selected wins, provided you own its actor — for a player, the only kind Foundry
  lets them select anyway. Otherwise a player gets their own character, or whichever of
  their creatures is in the fight, and never the acting monster — so their reaction pip
  is on screen during somebody else's turn. The GM's bar falls back to whoever is
  currently acting.
- **One bar, for every creature.** A BG3-style hotbar: one grid of slots on a painted
  field with the empty ones drawn in, the action cost as a marker on each slot, category
  tabs above it and `+`/`-` for how many rows you want. A goblin gets the same bar a
  wizard does — only the economy differs, and only because nothing is counted for a
  creature the GM runs.
- **Arrange the bar by dragging its icons.** Drop an icon on another and the two trade
  places; drop it on an empty cell and it moves there, leaving the gap you made on
  purpose intact. Let go outside the bar and it offers to take that button off it. The
  gear dialog has a *Reset order* button that undoes the lot.
- **Category tabs.** *All* leads the strip, then Weapons, Spells, Features, Consumables,
  Gear and Passives — only the ones this creature actually has something in. Clicking the
  lit tab widens the grid again. Passives sit on their own tab rather than filling
  hotbar slots.
- **Spell slots, next to the pips.** One row per spell level with a pip per slot, so you
  see what is left without reading a number. Pact Magic gets its own row. Spells you have
  no slot left for grey themselves out — upcasting counted, cantrips and at-will casting
  never — so "can I still cast this" is answered before you ask. Spells sort by level,
  cantrips first.
- **Everything a slot needs to say, on the slot.** Its pool as a coloured marker,
  remaining charges, attacks left inside the current action, and a link-slash when the
  item has a second button elsewhere. Each badge owns its own corner, so a Breath Weapon
  really can show all of them at once.
- **Nothing moves.** The bar has a fixed width, so switching tabs or switching creatures
  never slides the buttons out from under your pointer.
- **Descriptions, pinned.** Middle-click any slot (or left-click a passive) to pin
  dnd5e's own item card — the same card the character sheet shows — beside the button.
  It floats above everything, so no sheet covers it and the bar costs no height for it.
  Click the card, middle-click the slot again, or switch creature to dismiss it.
- **Passive features.** Feats with nothing to click (Weapon Mastery, Tactical Shift, …)
  get their own tab as read-only reference cards, out of the hotbar slots entirely.
- **Portrait shortcuts.** Click for the character sheet; at 0 HP it turns into a skull
  that rolls a death saving throw, and the label below takes the successes and failures
  as pips — while you are dying, `0/40` says nothing the skull has not already said. The
  ring around the portrait is the HP gauge, and its rim turns cyan while the creature is
  carrying temporary hit points — the amount rides on that same label as a `+7`, because
  temp HP sits on top of `value/max` rather than being part of it.

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

**House rules** — *Pay costly material components in gold* (off by default): a spell
whose component has a price is cast without carrying the item, as long as the character
has the money. What the spell consumes is paid — in the same write as the spell slot, so
the chat card's refund button returns the gold too — and what it does not consume
(Identify's pearl, Chromatic Orb's diamond) only has to be affordable. The price is read
from the component text ("a diamond worth 300+ GP, which the spell consumes"), because
the 2024 compendium leaves the spell's *Cost* field at 0; a cost entered there wins over
the text. Player characters' own spells only: scrolls, wands and monsters cast without
components. While the rule is on, the purse sits under the spell slots, a priced spell
carries a coin (spends gold) or a gem (money only has to be there) on its slot — red,
and the spell greyed, when the purse is short — and dnd5e's casting dialog says what is
about to be paid: *Pays 300 gp — purse 512 gp → 212 gp*. Not enough money blocks the cast, except for the GM when *GM bypasses
enforcement* is on.

**Content filters** — hide unequipped gear, hide unprepared spells.

**Targeting** (per user) — when the target picker opens: *Always* (current targets
preselected), *Only when the current targets don't fit*, or *Off*, which leaves your
targets entirely alone.

**Presentation** (per user) — HUD scale and sort order. How many rows the grid has is
remembered per user too, but is set with the `+`/`-` on the bar itself rather than here.

### Who gets counted

The bar exists to help the person playing a creature keep track of what it can still
do. That person is not the GM, who already knows a goblin has one action and reads its
Multiattack off the statblock in front of them — so **only creatures with a player owner
have an action economy.** Everything else about the bar is identical either way.

| | Player-owned | GM-only |
| --- | --- | --- |
| Ability list, grouped by pool | yes | yes |
| Which pool an entry belongs to (gear dialog) | yes | yes |
| Category tabs, arranging, the gear dialog | yes | yes |
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

- **A refill that never happened.** Turn resets run on the active GM's client, so a
  reconnect or a throttled background tab could leave a player's pools spent into the
  next round — a bar refusing a legitimate action while looking entirely certain about
  it. If a creature's turn comes round and its economy was never refilled, the bar
  notices and treats it as refilled.

The GM can correct any pool by hand: click a pool to hand one pip back, right-click to
spend one. There is also a *Reset turn* button that refills everything.

### How a click picks its targets

dnd5e copies your targets onto the usage card and onto the attack roll *while* the
activity is being used, so the bar settles them first, from the activity's own
*Target* and *Range* fields:

| The activity says | What the bar does |
| --- | --- |
| Target *Self* (Second Wind, Action Surge, Rage, Shield, Detect Magic) | Targets your own token, no question asked. |
| No target, range *Self*, and nothing that deals damage (Mirror Image, Blur) | Same — it can only be about you. |
| *N creatures / allies / enemies / objects* (Fire Bolt, Healing Word, Bless, Hold Person, Magic Missile) | Picker, starting empty — targets left over from the last spell are cleared, never preselected — nearest first, with what is out of range below a divider. Allies and enemies are told apart by token disposition. At *N* the remaining rows lock; with one target, clicking another row moves the choice, and a double-click confirms. |
| *Any number of creatures* (Beacon of Hope) | Picker without a limit. |
| A weapon or spell attack with no stated target (every weapon, Scorching Ray) | Picker for one target. You are not on your own attack's list. |
| *Touch* (Cure Wounds, Protection from Evil and Good, Shocking Grasp) | Picker; a touch heal or buff starts on you. Anyone beyond 5 ft is listed under *Beyond touch* rather than hidden, since reach and size stretch it. |
| Range *Self* with a creature target — riders and handed-over items (Sneak Attack, Stunning Strike, Lay on Hands, a Potion of Healing) | Picker for one, no range limit, an attack rider keeps the creature you just attacked; a heal or potion starts on you. |
| An area (Fireball, Burning Hands, Spirit Guardians, a breath weapon) | dnd5e places the template as usual; afterwards everything inside is targeted and the card's *Targeted* list is updated, so its damage and save buttons apply to them. A Cone, Line, Cube or Emanation that starts at you leaves you out (2024 rules); a Sphere at range does not. *Creatures of your choice* (Spirit Guardians) and areas that affect fewer creatures than they cover (Phantasmal Force) open the picker with the catch preselected. |
| A space or point (Misty Step, Spiritual Weapon, a summon) | Clears your targets, so the card claims none. |

Spells whose target count grows with the slot (Bless, Hold Person, Magic Missile) let
you pick up to what your highest remaining slot allows, because the slot is only chosen
afterwards in dnd5e's own dialog; if you then cast lower, the bar warns that you picked
more creatures than that casting affects.

The same happens for a cast started on the **character sheet**: dnd5e's hook cannot
wait for a picker, so the bar stops that use, asks, and starts it again with the targets
settled. Macros and other modules' automation (anything without a click) are left alone.

**Effects land on the targets.** dnd5e itself only puts an *Apply* button on the chat
card — which a player cannot use on a creature they do not own — so a buff like
Protection from Evil and Good otherwise did nothing but start concentration. With
*Apply buff and healing effects to the targets* on (world setting, default on), the
effects of utility and healing activities (Protection from Evil and Good, Bless, Shield,
Rage) are applied to the chosen targets right away, tied to the caster's concentration
exactly as dnd5e's button would, so dropping concentration removes them. Creatures the
caster does not own are written by the GM's client. Effects behind a saving throw or an
attack roll keep the manual button; with Midi QoL active this is left to Midi.

*Cancel* in the picker aborts the use and puts your old targets back; *Without a target*
uses it with none. **Shift-click** a slot to skip the picker once and use whatever is
targeted — the way to target on the canvas first. The *Only when the current targets
don't fit* setting keeps fitting targets without asking, leftovers included.

**With Midi QoL active, targeting belongs to Midi.** Midi replaces dnd5e's usage with its
own workflow — its own target confirmation, range checks, template targeting and effect
application — so the bar stays out of it entirely: no picker, no auto-targeting, no
effects of its own. A click on the bar is used exactly the way the character sheet uses
it, so whatever Midi does for a sheet cast it does for the bar. For a picker on every
cast, set Midi's *Target Confirmation* to taste.

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
