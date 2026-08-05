# A DnD 5e HUD To Rule Them All

A combat HUD for Foundry VTT that does three things at once: show every activity a
creature can actually use, grouped by action type — track the action / bonus action /
reaction economy — and show how much movement is left.

**Foundry v13** · **dnd5e 5.x** · MIT · `0.1.0` (pre-alpha)

---

## Why another combat HUD

Existing HUDs are good at *listing* what a creature can do. They are much weaker at
answering the question that actually slows a table down: *have I already used my bonus
action this turn, and how far can I still move?*

This module treats the action economy as the primary feature and the button grid as the
thing wrapped around it.

Also most of the other ones just simply don't suit my parties needs, so I'm making this one.

## Features

- **Activity-aware action list.** Walks every activity on every item, not just items, so
  a weapon with an attack plus a utility activity shows up in both the action and the
  bonus action group.
- **Economy tracking.** Action, bonus action, reaction, free object interaction and
  legendary actions, tracked per combatant — including reactions spent on other
  creatures' turns.
- **Movement budget.** Derived from Foundry v13's own movement history, so difficult
  terrain and Dash are accounted for without a second bookkeeping system.
- **One write path.** Costs are booked in `dnd5e.postUseActivity`, so a click in the HUD,
  a click on the character sheet, a macro and a Midi QoL workflow all count identically
  and none of them double-count.
- **Three enforcement levels.** Track silently, warn, or block the usage outright.
- **Manual correction.** Every pool can be adjusted by hand, and the last booking can be
  undone — because no automation survives contact with a real table.

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

**Rules** — pool sizes for action, bonus action, reaction and free interaction, and
whether Dash costs an action.

**Enforcement** — `Track only`, `Warn`, or `Block the usage`. Plus a separate toggle for
movement, and a GM bypass.

**Content filters** — hide unequipped gear, hide unprepared spells, show or hide the
generic actions (Dash, Dodge, Hide, …).

**Presentation** (per user) — HUD scale, sort order, visibility on other creatures' turns.

Per-actor overrides for pool sizes are read from the actor flag
`flags.dnd5e-hud-to-rule-them-all.config.max`. Extra Attack is handled the same way:
`flags.dnd5e-hud-to-rule-them-all.config.attacksPerAction` (default `1`) sets how many
"attack"-type activity uses share a single action for that actor — dnd5e has no
reliable built-in signal for this, so it's GM-configured per character rather than
guessed at.

## Public API

```js
const api = game.modules.get("dnd5e-hud-to-rule-them-all").api;

api.getEconomy(combatant);            // { used, max, dash, log }
api.getMovement(combatant);           // { base, budget, used, left, units, modes }
await api.spend(combatant, "bonus", { label: "Cunning Action" });
await api.refund(combatant);          // undoes the last booking
await api.resetTurn(combatant);
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
git tag v0.2.0 && git push --tags
```

## Roadmap

- [x] **M0** — scaffold, HUD renders for the active combatant
- [ ] **M1** — economy correct across a full round, manual correction, undo
- [ ] **M2** — movement incl. Dash and movement modes, optional hard stop
- [ ] **M3** — configurability: layout, filters, rule toggles, per-actor overrides
- [ ] **M4** — parity: spell slots, item uses, concentration, targeting, Extra Attack
- [ ] **M5** — polish: keybindings, repositioning, theming, docs

## Acknowledgements

The activity-enumeration approach owes a lot to reading how Token Action HUD and Argon
solve the same problem. No code was copied from either.

## License

MIT. See `LICENSE`.
