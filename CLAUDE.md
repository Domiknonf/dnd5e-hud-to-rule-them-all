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

Two things `node --check` cannot see, both of which have already broken this module
once. Check them by hand after touching templates or imports:

- **Every `PARTS` template renders exactly one root element** — count roots with a depth
  counter, not by balancing tags. Two siblings and zero roots both throw.
- **No import cycles between `scripts/*.mjs`** — walk the `from "./x.mjs"` graph.
- **Every `data-action` in a template has a handler** in some `DEFAULT_OPTIONS.actions`.
  A button wired to nothing looks completely normal and simply does nothing when clicked.
- **No i18n key is both a leaf and a branch.** Foundry expands the dotted keys in
  `lang/en.json` into a nested object, so shipping `…entries.attack` *and*
  `…entries.attack.yes` asks one key to be a string and an object at once. That takes
  down the module's whole translation table — every key everywhere renders raw, which
  looks nothing like an i18n bug. `JSON.parse` cannot see it; check for any key that is
  a prefix of another key plus a dot.

Verification is manual, in a running Foundry world. If a change cannot be verified by
reading the code, say so rather than claiming it works.

## Architecture

| File | Responsibility |
| --- | --- |
| `scripts/const.mjs` | Every runtime assumption: pool definitions, activation-type map |
| `scripts/economy.mjs` | State model. The **only** place that reads or writes the economy flag |
| `scripts/config.mjs` | Per-actor configuration, storage only. The **only** place that reads or writes the config flag. Imports nothing but `const.mjs` — see below |
| `scripts/config-app.mjs` | The dialog that edits that config, plus the suggestion/notice logic |
| `scripts/multiattack-app.mjs` | The Multiattack editor: alternatives and their parts |
| `scripts/actions.mjs` | Walks actor items, buckets their activities, applies per-entry rules |
| `scripts/hud.mjs` | The `ApplicationV2` and its action handlers |
| `scripts/socket.mjs` | Relays player writes to the active GM |
| `scripts/module.mjs` | Hook wiring only. No business logic belongs here |

### Three load-bearing decisions

**1. The economy lives in a flag on the Combatant document.**
Key: `flags["dnd5e-hud-to-rule-them-all"].economy`. Combatant flags replicate to all
clients and disappear with the encounter. Players own their Actor but usually not the
Combatant, so their writes go through `socket.mjs` to the active GM. Never write this flag
outside `economy.mjs`.

**2. There is exactly one write path for costs.**
`dnd5e.postUseActivity` books them. HUD buttons only call `activity.use()`. This is why
sheet clicks, macros and Midi QoL workflows all count correctly and none double-count. Do
not add a second booking site.

**3. Configuration beats detection. Detection is only ever a suggestion.**
Key: `flags["dnd5e-hud-to-rule-them-all"].config`, on the **Actor** (not the Combatant —
this has to outlive the encounter). Everything this module cannot know for certain is
answered by whoever owns the character, in the gear dialog: how many attacks an Attack
action grants, how big the pools are. The heuristics in `actions.mjs`
(`guessAttacksPerAction` and friends) still run, but only to prefill that dialog and as
the fallback while nothing has been configured — that fallback is what keeps a freshly
dropped pack of NPCs usable without configuring six statblocks first.

Consequences to respect:

- Never write that flag outside `config.mjs`, the same rule the economy flag has.
- **`config.mjs` imports nothing but `const.mjs`, on purpose.** `actions.mjs` asks it what
  an entry was configured to be, while the dialog asks `actions.mjs` what to suggest.
  Keeping storage free of the detection is what stops that from being an import cycle;
  the dialog lives in `config-app.mjs` for the same reason. There is a cycle check in the
  verification snippet below — run it after moving imports around.
- **Per-entry rules live under `config.entries`, keyed by document ID, never by uuid.** A
  synthetic token actor's uuid carries its scene and token, so a uuid key written for one
  goblin would never match the base Actor the config is stored on. `entryKey()` builds
  `itemId` or `itemId:activityId`; the activity rule wins over the item rule.
- **Prefer the item-level key.** A rule on `itemId` also covers activities the item gains
  later; a pile of per-activity rules does not. A drop writes the item key whenever the
  dragged button already covers the whole item.
- **Some items split across pools, and no heuristic fixes that.** dnd5e models "as a bonus
  action, cast one of these" as several `cast` activities, and a non-overriding `cast`
  activity reports the *spell's* casting time, not what the feature costs — so a Planetar's
  Divine Aid arrives as one Action button and one Bonus Action button although the sheet
  lists it once as a Bonus Action. `collectConfigurable` marks those entries `split`, the
  dialog shows a link-slash icon on them, and the drop asks "move all of it or just this
  group?" with *all of it* as the default. Do not try to guess it instead.
- Six things a rule can say: `pool` (overrides `ACTIVATION_MAP`), `attack` (overrides
  the `activity.type === "attack"` / `ATTACK_SUBSTITUTE_NAMES` guess), `attacks` (how
  many attacks this entry grants when it *opens* the Attack action), `grants` (what
  using it *adds* to the pools this turn — Action Surge; `false` overrides
  `ACTION_GRANT_NAMES` to "nothing"), `hidden`, and `sort` (position within its pool).
  All but `sort` are resolved in `actions.mjs` (`poolFor`, `countsAsAttack`,
  `attacksForActivity`, `grantsForActivity`), so the HUD, the gate and the booking
  path all see the same answer — including usages from the sheet or a macro.
- **Three things outside the config change the economy**, all in `const.mjs`:
  `BLOCKING_CONDITIONS` (matched on `actor.statuses`, so any module's Stunned works),
  `EFFECT_POOL_BONUS` and `EFFECT_EXCLUSIVE_POOLS` (matched on English effect names).
  Conditions **bar** pools rather than shrinking them — zeroing the max would empty
  the economy row, which reads as a broken bar instead of as "you are Stunned". Haste
  is a capacity change and belongs in `getMaxima`, NOT in `ACTION_GRANT_NAMES`: it is
  an effect on a target, so booking it on use would hand the extra action to the
  caster. Slow is neither — it couples two pools into one budget (`coupledOut`).
- **`getEconomy` recomputes the maxima and the fresh ones win.** Letting the stored
  ones override froze `max` at whatever it was when the flag was last written, so a
  Haste landing mid-turn did nothing until the next turn reset. Nothing writes a max
  that `getMaxima()` cannot recompute, so there is nothing there to preserve.
- **`grants` is the only rule that gives instead of costs.** A second action is not a
  discount on the first, so it cannot be modelled as a cost of zero — it has to raise
  the pool. It lives in `econ.granted`, a per-turn full map with zeros (same
  merge reason as `multiattack.used`), and is read through `economy.poolMax()`.
  Never fold it into `econ.max`: that is recomputed from settings on every read and
  written back, so a grant folded in there is counted again on the next write.
- **`config-app #write()` lists every field a rule may carry.** Anything unlisted is
  deleted by the next drag, which is the per-entry twin of the `#onSubmit` trap.
- **Multiattack is `config.multiattack.options`**, `[{ parts: [{ key, count }] }]`. One
  option is one alternative (take exactly one); several parts inside an option are
  combined. "Two Holy Bursts *or* three Radiant Swords" is two options; "one bite *and*
  two claws" is one option with two parts.
- **Nothing asks which alternative is being taken.** `economy.viableOptions` keeps every
  option alive until a use rules it out — click A and both "two A" and "A plus B" stay
  open; a second A kills the latter, a B kills the former. The bar just shows what is
  still allowed, so the interaction is the answer instead of a dialog interrupting the
  turn. This is why the state is `multiattack.used` (what happened) rather than a
  remaining total.
- The per-entry `attacks` rule still exists for the simple case and is what
  `spendAttack` uses when no Multiattack is configured.
- **The zones are seeded by detection, not empty.** That is what makes the dialog a
  correction surface instead of something you must fill in before the bar works, and it
  is what gives the mismatch confirmation something to compare against. Dropping an
  entry back where detection wanted it *removes* the rule rather than pinning the same
  value — otherwise "auto" could never be restored by dragging.
- **The Multiattack editor is seeded the same way**, from `suggestMultiattack()`, but
  only while nothing is configured — what is stored always wins. Nothing is written
  until Save, so closing the dialog declines the offer, and a banner says the prefill
  is not in force yet. Unlike the zones there is no live fallback behind it:
  `multiattackOptions()` reads config and nothing else, so an unsaved prefill has no
  effect on the bar at all.
- Reordering writes a `sort` onto every tile in the touched zone. `sort` therefore does
  **not** count towards an entry's "overridden" mark, or a single reorder would light up
  the whole zone.
- `hidden` removes an entry from the bar. It does **not** make it free: `costOfActivity`
  deliberately ignores the flag.
- Config is stored on the **base** Actor (`configTarget`), so five unlinked goblins from
  one prototype share it instead of needing five identical dialogs.
- Players own their Actor, so they write config directly — no `socket.mjs` relay here.
  The GM owns every Actor, which is what lets one dialog configure the whole party.
- Do not add automation that silently overwrites a configured value. When detection and
  configuration disagree, the gear gets a mark (`config.attackNotice`) and the dialog
  offers the change with the feature that caused it quoted by name. The player decides.
- **Dismissal stores the dismissed value, not a boolean.** `config.seenAttackSuggestion`
  holds the count that was waved away, so silencing "3" is permanent for 3 while a later
  tier suggesting 4 raises the mark again on its own. A boolean would swallow every
  future level-up and would have to be reset by hand — which defeats the feature.
  `config.seenMultiattackSuggestion` does the same for the Multiattack, holding the
  `multiattackKey()` signature of the reading that was answered. Re-statting a creature
  changes the signature and raises the mark again; reordering the alternatives does not,
  because that is the same answer. Saving the editor records it too — the reading was on
  screen, prefilled, and the player pressed Save.
- **The Multiattack mark is silent for what a number already covers.** A statblock
  reading of one alternative with one attack *is* an attacks-per-action number, and
  `attackNotice` already speaks for that. Marking it here as well would put a permanent
  mark on every ordinary monster in the encounter. There is no one-click "apply"
  either: applying would write a guess into the config, so the offer is the editor
  opening prefilled with it.
- Whatever the dialog does not render has to be carried across in `#onSubmit`: the write
  replaces the whole config object, so an unlisted field is a field that gets deleted on
  the next save. That is now **four** fields — `entries`, `seenAttackSuggestion`,
  `multiattack`, `seenMultiattackSuggestion` — and forgetting one has already silently
  deleted a configured Multiattack once. Add to that list whenever you add a field.
- When you extend this, add a field to the dialog rather than a new heuristic.

### The bar's lifecycle

The HUD is **not** combat-scoped. It renders whenever there is anyone to show
(`CombatHUD#subjectActor`) and only closes when that is null.

**Who the bar shows is a permission question, not just a convenience one.** A selected
token always wins, for everyone. The fallback differs:

- **GM** → whoever is currently acting. They run the encounter.
- **Player** → their *own* character, never the acting creature. Following the turn
  pointer meant a player's bar filled up with the acting goblin — which hid their own
  reaction pips at the one moment a reaction matters, and printed the monster's whole
  ability list into their UI.

`subjectCombatant` is the subject's **own** combatant, never `combat.combatant`. That is
what keeps the economy row attached to the creature in the bar; using the active one
would show a player their character wearing the monster's pips. Everything turn-bound
(`isMyTurn`, End Turn, reset) hangs off it too.

- Ending an encounter **collapses** it (`deleteCombat` → `collapse(true)`); starting one
  pulls it back up. Both are just the slide the handle does, so it can always be brought
  back by hand.
- Outside an encounter there is no Combatant, so nothing is booked and the economy row is
  hidden. `_prepareContext` keeps `combatant` null in that case, which is what makes every
  economy call inert instead of needing branches.
- **Two collapse handles exist on purpose.** The one inside `.hudtra-frame` rides the
  frame's collapse transform; a transformed element becomes the containing block for its
  positioned descendants, so it cannot be pinned to the viewport. `.hudtra-reopen` is a
  sibling of the frame for exactly that reason, and sits in the bottom-right corner to
  stay clear of Foundry's centred macro bar.
- The macro bar (`#hotbar`) is hidden only while the bar is **expanded**
  (`:not(.collapsed)`), so collapsing gives it back. The class is toggled without a
  re-render and `:has()` tracks that live.

## Domain model

In dnd5e 4.x+ the unit of "a thing you do" is an **Activity**, not an Item. One item can
carry several activities with different activation types. Always iterate
`item.system.activities`; never infer an action type from the item alone.

`activity.activation.type` maps to our pools via `ACTIVATION_MAP` in `const.mjs`.
Time-based types (`minute`, `hour`, `shortRest`, …) are listed in
`OUT_OF_COMBAT_ACTIVATIONS` and are dropped, not bucketed.

**Off-turn, an action-cost activity is a reaction** (`economy.poolForNow`). Nothing in
dnd5e marks an Opportunity Attack as one — the sheet, a macro and Midi all fire the
same activity, still declaring activation `action` — so whose turn it is is the only
signal there is. Both hooks in `module.mjs` resolve the pool through it before doing
anything, so the gate and the booking always agree. Only `action` moves: `legendary`
and `lair` are off-turn *by design*, `bonus` has no off-turn form worth guessing at.
An off-turn attack therefore never reaches `spendAttack`, which is right — an
Opportunity Attack does not open an Attack action or queue Extra Attacks.

## Conventions

- **ESM only.** `.mjs`, relative imports, no bundler, no TypeScript.
- **ApplicationV2 only.** `foundry.applications.api.HandlebarsApplicationMixin(ApplicationV2)`.
  Never `Application`, `FormApplication` or `Dialog` — all deprecated in v13. Use
  `DialogV2` for prompts.
- **Every `PARTS` template renders exactly one root element**, always — including the
  branch where there is nothing to show. Two siblings, or an empty render, throws
  `Template part "…" must render a single HTML element` and the application never
  appears. Put the `{{#if}}` *inside* the wrapper, never around it. This is why
  `hud.hbs` opens with `.hudtra-root`.
- **Namespaced globals.** Prefer `foundry.applications.handlebars.loadTemplates` over the
  bare global, and likewise for other v13-namespaced helpers. If you are unsure whether a
  global is deprecated, check the console for deprecation warnings rather than guessing.
- **Declarative click handling.** `data-action="name"` in the template, static handler in
  `DEFAULT_OPTIONS.actions`. No manual `addEventListener`, no jQuery. Two documented
  exceptions, both because ApplicationV2 only binds `click`/`contextmenu`: the
  middle-click description popup needs a delegated `auxclick` listener in
  `hud.mjs -> _onFirstRender`, and the config dialog's drop zones need the four HTML5
  drag events in `config-app.mjs -> _onFirstRender`. Both are delegated from the
  persistent root and bound once. Do not add further listeners.
- **No browser storage.** No `localStorage` or `sessionStorage`. State goes in document
  flags or `game.settings`.
- **CSS lives in `@layer modules`** and uses Foundry's CSS variables so light and dark
  theme both work. No `!important`.
- **All user-facing strings are i18n keys** under `dnd5e-hud-to-rule-them-all.*`, added to
  `lang/en.json`. Never hardcode display text. **English is the only shipped locale** —
  the table plays in English and the compendiums are English, which is also what the
  detection in `actions.mjs` matches against. Do not add a second language file.
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

- **Extra Attack / Multiattack.** Handled in full, including the mixed case. See below.
- **Reactions off-turn.** Solved. A player's bar stays on their own character all
  encounter, so their reaction pip is visible and clickable during someone else's turn.
  `setCombatant` still exists and nothing calls it — it is now only a GM convenience
  (pin a combatant instead of following the turn), not a gap.
- **Missed hooks.** If the GM client misses a turn change, no reset happens. The flag's
  `key` field records `round:turn` as the hook for a future staleness guard.
- **Midi QoL** wraps activity usage. VERIFIED LIVE: both `dnd5e.preUseActivity` and
  `dnd5e.postUseActivity` do fire, in that order, around Midi's own workflow, and
  `activity.type` / `activation.type` still read correctly (`attack` / `action`).
  What Midi *does* change is the activity NAME — every wrapped activity calls
  itself "Midi Attack" — which is why `GENERIC_ACTIVITY_NAMES` exists and why the
  economy log goes through `useLabel()`. Note the hooks are not awaited by
  Foundry, so a callback registered later reads the economy *before* our async
  booking has landed; that is not a missed write.

## Working style in this repo

- Small, reviewable changes. This is a personal project used at a live table.
- When touching the economy or the booking path, state which of the two load-bearing
  decisions the change affects.
- Prefer extending the data tables in `const.mjs` over adding branches in logic files.
- If a change would need a new dependency, a build step, or a second write path, propose
  it before implementing.
