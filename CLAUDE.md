# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A Foundry VTT module: a combat HUD for D&D 5e that lists usable activities grouped by
action type and tracks the action economy. (Movement tracking, the generic intrinsic
actions and the Free Interaction pool existed in early versions and were deliberately
removed — do not reintroduce them.)

**Pinned targets — do not write code for other versions:**

- Foundry VTT **13** (verified 13.351)
- dnd5e system **5.3.3**
- No runtime dependencies. Do not add one without asking first.

## Commands

There is no build, no test runner, no linter configured yet.

```bash
node --check scripts/*.mjs     # syntax check, the only automated check that exists
git tag vX.Y.Z && git push --tags   # cuts a release via .github/workflows/release.yml
```

Verification is manual, in a running Foundry world. If a change cannot be verified by
reading the code, say so rather than claiming it works.

## Architecture

| File | Responsibility |
| --- | --- |
| `scripts/const.mjs` | Every runtime assumption: pool definitions, activation-type map |
| `scripts/economy.mjs` | State model. The **only** place that reads or writes the economy flag |
| `scripts/actions.mjs` | Walks actor items, buckets their activities |
| `scripts/hud.mjs` | The `ApplicationV2` and its action handlers |
| `scripts/socket.mjs` | Relays player writes to the active GM |
| `scripts/module.mjs` | Hook wiring only. No business logic belongs here |

### Two load-bearing decisions

**1. The economy lives in a flag on the Combatant document.**
Key: `flags["dnd5e-hud-to-rule-them-all"].economy`. Combatant flags replicate to all
clients and disappear with the encounter. Players own their Actor but usually not the
Combatant, so their writes go through `socket.mjs` to the active GM. Never write this flag
outside `economy.mjs`.

**2. There is exactly one write path for costs.**
`dnd5e.postUseActivity` books them. HUD buttons only call `activity.use()`. This is why
sheet clicks, macros and Midi QoL workflows all count correctly and none double-count. Do
not add a second booking site.

## Domain model

In dnd5e 4.x+ the unit of "a thing you do" is an **Activity**, not an Item. One item can
carry several activities with different activation types. Always iterate
`item.system.activities`; never infer an action type from the item alone.

`activity.activation.type` maps to our pools via `ACTIVATION_MAP` in `const.mjs`.
Time-based types (`minute`, `hour`, `shortRest`, …) are listed in
`OUT_OF_COMBAT_ACTIVATIONS` and are dropped, not bucketed.

## Conventions

- **ESM only.** `.mjs`, relative imports, no bundler, no TypeScript.
- **ApplicationV2 only.** `foundry.applications.api.HandlebarsApplicationMixin(ApplicationV2)`.
  Never `Application`, `FormApplication` or `Dialog` — all deprecated in v13. Use
  `DialogV2` for prompts.
- **Namespaced globals.** Prefer `foundry.applications.handlebars.loadTemplates` over the
  bare global, and likewise for other v13-namespaced helpers. If you are unsure whether a
  global is deprecated, check the console for deprecation warnings rather than guessing.
- **Declarative click handling.** `data-action="name"` in the template, static handler in
  `DEFAULT_OPTIONS.actions`. No manual `addEventListener`, no jQuery. One documented
  exception: ApplicationV2 only binds `click`/`contextmenu`, so the middle-click
  description popup needs a single delegated `auxclick` listener in
  `hud.mjs -> _onFirstRender`. Do not add further listeners.
- **No browser storage.** No `localStorage` or `sessionStorage`. State goes in document
  flags or `game.settings`.
- **CSS lives in `@layer modules`** and uses Foundry's CSS variables so light and dark
  theme both work. No `!important`.
- **All user-facing strings are i18n keys** under `dnd5e-hud-to-rule-them-all.*`, added to
  both `lang/en.json` and `lang/de.json`. Never hardcode display text.
- **Defensive reads.** Optional chaining and fallbacks around system and core APIs, e.g.
  `token?.movementHistory ?? token?.movement?.history`. This codebase runs against a
  moving target.
- Comments explain *why*, not *what*. Code comments in English.

## Assumptions that must be verified, not guessed

These are pinned in `const.mjs` because they may drift between system and core releases.
If behaviour looks wrong, check these first and report what you find — do not silently
rewrite them.

```js
Object.keys(CONFIG.DND5E.activityActivationTypes)   // does ACTIVATION_MAP still match?
CONFIG.debug.hooks = true                           // does combatTurnChange fire as expected?
game.combat.combatant.flags["dnd5e-hud-to-rule-them-all"]
```

## Known open problems

Do not "fix" these casually — each needs a design decision.

- **Extra Attack.** One Attack action contains several attack rolls, but costs are booked
  per activity use, so the second attack currently eats a second action. Needs a per-turn
  "attacks remaining inside this Attack action" counter.
- **Reactions off-turn.** Tracked correctly, but the HUD must stay visible and switchable
  during other creatures' turns for that to be usable.
- **Missed hooks.** If the GM client misses a turn change, no reset happens. The flag's
  `key` field records `round:turn` as the hook for a future staleness guard.
- **Midi QoL** wraps activity usage. The dnd5e hooks still fire; verify ordering before
  adding Midi-specific hooks.

## Working style in this repo

- Small, reviewable changes. This is a personal project used at a live table.
- When touching the economy or the booking path, state which of the two load-bearing
  decisions the change affects.
- Prefer extending the data tables in `const.mjs` over adding branches in logic files.
- If a change would need a new dependency, a build step, or a second write path, propose
  it before implementing.
