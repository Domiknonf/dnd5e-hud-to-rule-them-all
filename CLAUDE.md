# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A Foundry VTT module: a combat HUD for D&D 5e that lists usable activities grouped by
action type and, for the creatures somebody plays, tracks the action economy.

Removed deliberately, in this order — **do not reintroduce any of them**: movement
tracking, the generic intrinsic actions and the Free Interaction pool (early versions);
the Multiattack editor and every heuristic that read monster prose (0.5.0, together with
the economy on GM-run creatures — see the fourth load-bearing decision).

**Pinned targets — do not write code for other versions:**

- Foundry VTT **13** (verified 13.351)
- dnd5e system **5.3.3**
- No runtime dependencies. Do not add one without asking first.

## Commands

There is no build, no test runner, no linter configured yet.

```bash
node --check scripts/*.mjs     # syntax check
node tools/verify.mjs          # the checks below, all of them
git tag vX.Y.Z && git push --tags   # cuts a release via .github/workflows/release.yml
```

`tools/verify.mjs` reads files and writes none. It covers everything in this list — run
it after touching templates, imports or `lang/en.json`. Each item has broken this module
at least once, and none of them is visible to `node --check`:

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
- **Every statically referenced i18n key exists in `lang/en.json`.** Interpolated ones
  (`` `${MODULE_ID}.pool.${key}` ``) cannot be checked and are skipped — eyeball those.

Passing all of that still proves very little. Verification is manual, in a running
Foundry world. If a change cannot be verified by
reading the code, say so rather than claiming it works.

## Architecture

| File | Responsibility |
| --- | --- |
| `scripts/const.mjs` | Every runtime assumption: pool definitions, activation-type map |
| `scripts/economy.mjs` | State model. The **only** place that reads or writes the economy flag |
| `scripts/config.mjs` | Per-actor configuration, storage only. The **only** place that reads or writes the config flag. Imports nothing but `const.mjs` — see below |
| `scripts/config-app.mjs` | The dialog that edits that config, plus the suggestion/notice logic |
| `scripts/actions.mjs` | Walks actor items, buckets their activities, applies per-entry rules |
| `scripts/spells.mjs` | Reads the actor's spell slots. Imports nothing, writes nothing |
| `scripts/hud.mjs` | The `ApplicationV2` and its action handlers |
| `scripts/socket.mjs` | Relays player writes to the active GM |
| `scripts/module.mjs` | Hook wiring only. No business logic belongs here |

### Four load-bearing decisions

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
answered by whoever owns the character, in the gear dialog: which pool an entry belongs
to, how many attacks an Attack action grants, how big the pools are. What is left of the
detection (`guessAttacksPerAction`, a fixed English name lookup) still runs, but only to
prefill that dialog and as the fallback while nothing has been configured.

Consequences to respect:

- Never write that flag outside `config.mjs`, the same rule the economy flag has.
- **`config.mjs` imports nothing but `const.mjs`, on purpose.** `actions.mjs` asks it what
  an entry was configured to be, while the dialog asks `actions.mjs` what to suggest.
  Keeping storage free of the detection is what stops that from being an import cycle;
  the dialog lives in `config-app.mjs` for the same reason. `tools/verify.mjs` checks for
  cycles — run it after moving imports around.
- **The hot paths read the rules table once, not per activity.** `entryRules(actor)`
  returns the whole `config.entries` map and `ruleFor(rules, item, activity)` resolves
  against it; `entryConfig(actor, item, activity)` is the same answer for callers with
  one activity in hand (the booking path). `collectActions` on a 60-item sheet went
  from ~250 `getFlag` calls per render to one — `Document#getFlag` validates the scope
  against every active module before it reads anything. **The resolved rule may be the
  stored object itself, so never mutate what `ruleFor`/`entryConfig` hands back**; the
  dialog copies before writing, which is what keeps that safe.
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
  `EFFECT_POOL_BONUS`, `EFFECT_EXCLUSIVE_POOLS` and `EFFECT_BLOCKED_POOLS` (anchored patterns against the
  English effect name — nothing agrees on it: dnd5e ships "Haste", DAE/Midi ship
  "Hasted". **Anchor them.** A loose `/slow/` also matches the Monk's Slow Fall and
  silently couples that character's pools for the rest of the fight).
  Conditions **bar** pools rather than shrinking them — zeroing the max would empty
  the economy row, which reads as a broken bar instead of as "you are Stunned". Haste
  is a capacity change and belongs in `getMaxima`, NOT in `ACTION_GRANT_NAMES`: it is
  an effect on a target, so booking it on use would hand the extra action to the
  caster. Slow is neither — it couples two pools into one budget (`coupledOut`).
- **`getEconomy` merges by hand, field by field**, rather than through
  `foundry.utils.mergeObject`, which deep-clones both sides on every call. The shape is
  fixed: `used` and `granted` are the only nested maps, and both are full maps from
  `freshEconomy` with the stored partial laid over them. **A new field on the economy
  has to be added to that merge**, or it will not survive a read.
- **`getEconomy` recomputes the maxima and the fresh ones win.** Letting the stored
  ones override froze `max` at whatever it was when the flag was last written, so a
  Haste landing mid-turn did nothing until the next turn reset. Nothing writes a max
  that `getMaxima()` cannot recompute, so there is nothing there to preserve.
- **One effect may be in several tables.** Slow both couples the action with the
  Bonus Action *and* bars the Reaction; modelling only the coupling left a Slowed
  creature taking Opportunity Attacks. Check the whole spell, not the clause that
  suggested the feature.
- **`grants` is the only rule that gives instead of costs.** A second action is not a
  discount on the first, so it cannot be modelled as a cost of zero — it has to raise
  the pool. It lives in `econ.granted`, a per-turn full map with zeros — `setFlag`
  merges recursively, so a key dropped between two writes keeps its old value — and is
  read through `economy.poolMax()`. Never fold it into `econ.max`: that is recomputed
  from settings on every read and written back, so a grant folded in there is counted
  again on the next write.
- **`config-app #write()` lists every field a rule may carry.** Anything unlisted is
  deleted by the next drag, which is the per-entry twin of the `#onSubmit` trap.
- The per-entry `attacks` rule is what `spendAttack` uses when one weapon grants a
  different number than the actor's own. It is stored but has no field in the dialog
  yet, which is exactly why `#write()` has to name it.
- **The zones are seeded by detection, not empty.** That is what makes the dialog a
  correction surface instead of something you must fill in before the bar works, and it
  is what gives the mismatch confirmation something to compare against. Dropping an
  entry back where detection wanted it *removes* the rule rather than pinning the same
  value — otherwise "auto" could never be restored by dragging.
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
- Whatever the dialog does not render has to be carried across in `#onSubmit`: the write
  replaces the whole config object, so an unlisted field is a field that gets deleted on
  the next save. That is `entries` and `seenAttackSuggestion` always, plus
  `attacksPerAction` and `max` **on an untracked creature**, where the form does not
  render them at all — hiding a field turns it into exactly this trap. Forgetting one
  has already silently deleted a whole configuration once. Add to that list whenever you
  add a field, and again whenever you make an existing field conditional.
- When you extend this, add a field to the dialog rather than a new heuristic.

**4. Only creatures with a player owner have an economy.**
`economy.isTracked(actor)` is `actor.hasPlayerOwner === true` — unless the world setting
`trackEveryone` is on, which counts everything and is the pre-0.5.0 behaviour. Default
**off**, so everything below is still what happens by default; it exists because "my
GM-owned test character has no pips" is the first thing that happens to anyone testing,
and because a table may simply want its monsters counted. World-scoped on purpose:
whether a creature is counted decides what lands in its Combatant flag, so two clients
must never disagree about it. `isTracked` is the switch for
the *counting* half of the module only: booking (`dnd5e.postUseActivity`), the gate
(`checkGate`), the turn resets, the pips, and the Extra Attack counter. The *list* half —
which activities exist, which pool each one is in, the per-entry rules, the drag-and-drop
zones, the Legendary/Reaction/Bonus sections — is untouched by it and works the same for
every creature. A GM steering a monster still gets the whole bar; they just do not get
pips.

The reasoning: the bar exists to help the person playing a creature see what it can still
do. That is not the GM, who already knows a goblin has one action — and with `gmBypass`
on (the default) the gate never stopped them anyway, so for GM creatures the pips were
bookkeeping nobody read, paid for with a Combatant flag write and a re-render on every
client per monster attack.

Consequences to respect:

- **Ownership, never `actor.type`.** A wildshaped druid, a summoned drake and a sidekick
  are all `npc` actors that somebody plays; an `actor.type === "npc"` check would take
  the bar away from exactly the players it is for.
- **Test it in `checkGate`, not in the hook**, so every caller of the gate agrees.
- **`hud.mjs` funnels every economy read through `econCombatant`** (`tracked ? combatant
  : null`), which makes them inert the same way being outside an encounter already did —
  rather than growing a second set of branches. `combatant` itself stays live: the round
  counter and End Turn are turn state, not economy.
- **`exhausted` still has to say `tracked &&` explicitly.** It is the one thing the null
  combatant does not handle: `legendary` has no world default, so its recomputed max is
  0, and the group would grey itself out on every monster that has one.
- This is what let the prose heuristics go. Their whole justification was that a freshly
  dropped pack of NPCs had to count correctly before anyone configured it, and NPCs are
  no longer counted. **Do not add a text parser back** — if a tracked creature needs a
  number, it gets a field in the dialog.

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

**Because the bar shows exactly one creature, most document hooks must not redraw it.**
`refreshHUDFor(actor, changed)` (in `hud.mjs`, beside `subjectActor` so the two cannot
drift) drops updates that cannot reach the bar; the actor, item, effect, token and
combatant hooks in `module.mjs` all route through it. Twelve monsters trading blows
used to mean a full rebuild per update on every client, producing identical markup.
Two rules keep it honest:

- **When in doubt, redraw.** An update with no actor behind it still refreshes.
- **Anything that decides WHO is shown redraws unconditionally** and therefore does
  *not* go through the filter: combat, adding and removing combatants, `controlToken`,
  `updateUser`, and any change touching `ownership`. Add a hook to the filtered list
  only after checking it against that list.

- Ending an encounter **collapses** it (`deleteCombat` → `collapse(true)`); starting one
  pulls it back up. Both are just the slide the handle does, so it can always be brought
  back by hand.
- Outside an encounter there is no Combatant, so nothing is booked and the economy row is
  hidden. `_prepareContext` keeps `combatant` null in that case, which is what makes every
  economy call inert instead of needing branches.
- **The frame has a `width`, not a `max-width`, and that is load-bearing.** The bar is
  centred, so a frame that sizes to its content moves every button on it by half of any
  width change — folding a section, switching to a creature with fewer abilities, a
  spell filter narrowing the list. Freeing space is not worth having the thing you were
  about to click walk out from under the pointer. The groups are left-aligned inside the
  fixed frame and `.hudtra-groups` scrolls when there is more than fits, so the cost is
  empty leather on a creature with few abilities, and nothing else.
- **Two collapse handles exist on purpose.** The one inside `.hudtra-frame` rides the
  frame's collapse transform; a transformed element becomes the containing block for its
  positioned descendants, so it cannot be pinned to the viewport. `.hudtra-reopen` is a
  sibling of the frame for exactly that reason, and sits in the bottom-right corner to
  stay clear of Foundry's centred macro bar.
- The macro bar (`#hotbar`) is hidden only while the bar is **expanded**
  (`:not(.collapsed)`), so collapsing gives it back. The class is toggled without a
  re-render and `:has()` tracks that live.

### Two layouts, one switch

`economy.isPlayed(actor)` — `hasPlayerOwner`, nothing else — decides how the bar is
drawn, not just whether it counts:

| | Played (PC, chain-pact imp, summon, wildshape) | GM-only (goblin, statblock) |
| --- | --- | --- |
| Layout | one BG3 grid, headerless | pool columns with headers |
| Pool shown as | a marker on each slot (`.hudtra-cost`) | the column header |
| Categories | tabs above the grid | fold chips in each header |
| Rows | `+` / `-`, client setting `gridRows` | two, fixed |

The reasoning is decision 4's: a person arranges their own character once and lives
with it; nobody arranges twelve goblins, so those keep a bar that fills itself.

- **It reads `isPlayed`, never `isTracked`.** `isTracked` carries the `trackEveryone`
  escape hatch for counting, and a GM turning counting on for testing must not be
  handed a layout that expects to be curated.
- **The empty slots are painted, not rendered** — a tiled SVG frame behind the grid, one
  tile per slot pitch. That is what makes the field a full rectangle at any width and
  any `--hudtra-scale` without measuring how many columns fit, and it costs no DOM on a
  bar that already builds a tooltip per slot. Every wrapper between the flex row and the
  grid has to pass the width through, or the field stops where the filled slots do.
- **One template, one loop.** The grid is a single group with `header: false` and one
  nameless section, so `hud.hbs` did not grow a second copy of the slot markup — the
  same trick the unsectioned group already used.
- The cost marker uses the same shape and colour per pool as the economy pips, so a
  green circle means the same thing in both places. CSS hides it in the grouped layout,
  where the header already says it.

### Folding: sections inside a group

Applies to the **GM layout** only — a played creature has tabs instead.

A caster's Action group runs to twenty-odd buttons, which is one undifferentiated wall
of art. `SECTIONS` in `const.mjs` is the second level of grouping — Weapons, Spells,
Features, Consumables, Gear — and every group header and section chip folds what is
under it away (`hud.mjs -> sectionsFor`, `#onToggleFold`).

- **Sections come from `item.type`, and that is why there is no config for them.** It is
  a system fact, not a reading of anything, so there is nothing for a player to correct
  — unlike a pool assignment, which is a guess and therefore has a zone in the dialog.
  Do not turn this into a sixth heuristic; if a section ever needs to be decided rather
  than looked up, it needs a field in the dialog like everything else.
- **Sectioning happens in `hud.mjs`, not in `collectActions`.** The buckets stay in the
  order the sort settings and the `sort` rule produced, so turning the setting off gives
  the flat order back without a second sort path. It also means sections group *before*
  `sort`, which orders entries within one — an entry dragged to the front of a zone
  leads its section, not the group. That trade is the price of the grouping and it is
  documented in the setting's own hint.
- **There is one rendering path.** An unsectioned group is a single nameless section, so
  `hud.hbs` loops over sections once instead of carrying two copies of the slot markup.
  Three ways to stay flat: the setting is off, the group is under
  `SECTION_MIN_ENTRIES`, or everything in it is the same kind of thing anyway (a passive
  list is all feats, and one section spanning the whole group says nothing).
- **A fold is not the bar's collapse.** `#onCollapse` toggles a class without a
  re-render so the slide animates; a fold *re-renders*, because folded content has to be
  gone from the DOM rather than merely invisible — a slot hidden with CSS is still a slot
  the browser lays out.
- **The fold state is a client setting (`folded`), keyed by `pool` or `pool:section`.**
  Per user, because it is a preference about one person's screen — two people looking at
  the same character fold different things. It is deliberately *not* an actor flag: a
  player would need write access to every monster the GM shows them. `passive` ships
  folded; unfolding it stores an object without the key, so the default does not come
  back on the next reload.
- Every header keeps a **count** while folded, and the control that folded it is the
  control that brings it back. Nothing on this bar may be hidden by something that is
  not visibly the way back.
- `.hudtra-group` carries a `min-height`: folding the passives away must not drop the
  whole bar's height by a row and shift everything under the pointer.
- **A folded chip says what it is holding.** Icon-only is fine while a section is
  showing — the slots are right there — but once folded, that chip is the only trace of
  the section, so it grows the name and the count and keeps full contrast. Never dim the
  only remaining evidence of something.

### Spell slots

In the resource cluster beside the portrait (`hud.mjs -> spellBarFor`), with the pips
they belong with. One row per spell level: how many slots are left there.

**A readout, not a control.** These rows used to filter the bar down to one level, which
answered the wrong question — mid-turn you want to know *can I still cast this*, so the
bar says so directly: `highestCastable` resolves the ceiling once per render and every
leveled spell above it is greyed out (`.hudtra-slot.unavailable`). A filter made you ask
the question, click, and undo the click; greying just tells you.

- **A ceiling, not a per-level check, because upcasting exists.** A 4th-level slot casts
  a 1st-level spell, so what matters is whether *any* slot at or above the spell's level
  is left. Pact slots count, at their own level.
- **Three things never grey**: cantrips, at-will/innate casting (`ATWILL_METHODS` in
  `actions.mjs` — they cost no slot), and every spell on a creature with no slot pools at
  all. That last one is the difference between `highestCastable` returning `-1` ("pools
  exist, all empty" — grey everything) and `null` ("nothing to conclude" — grey nothing).
- **Greyed, never hidden.** What you cannot cast this round you can still read, and it
  comes back on its own after a rest.

- **One row per slot pool, and nothing else.** Levels the creature knows spells at but
  has no pool for used to get a row marked "no slots at this level" — noise at best and
  a lie at worst, since a warlock has no `spell3` pool and casts 3rd-level spells all
  day out of the Pact Magic row below it. Cantrips go the same way: at-will, no pool, no
  row. Nothing is lost, because "can I cast this" is answered on the spell now. A pool
  with slots but no spell on the bar still shows — a scroll may spend it.
- **Slots are pips, not a number** (`SPELL_PIP_LIMIT` guards the homebrew case). Four
  dots answer "how many are left" without being read, which is the question the row
  exists for.
- **Pact Magic is a row of its own**, not folded into its level: it refills on a short
  rest and is spent separately, so one "3/4" covering both would be a lie in both
  directions.
- Spells inside a section sort by **level** first (cantrips up), then by the configured
  order — `Array#sort` is stable, so the `sort` rule and the A-Z setting still decide
  within one level.
- **Each badge on a slot owns one corner, and they collide if you forget which.** Cost
  marker bottom-left, attacks-left-in-this-action top-left, split marker top-right,
  charges bottom-right. A Breath Weapon really does carry charges *and* count as an
  attack *and* cost an action, so no two of them may share a corner.
- **The cost marker sits on a backing plate**, which is why it is two elements: the
  shape is a `clip-path` on the inner `<i>`, and a clip-path would take the plate with
  it. Slot art is whatever the content shipped — a green pip straight on Fire Bolt's
  green beam is invisible, so the plate is what makes it read the same everywhere.

## Domain model

In dnd5e 4.x+ the unit of "a thing you do" is an **Activity**, not an Item. One item can
carry several activities with different activation types. Always iterate
`item.system.activities`; never infer an action type from the item alone.

`activity.activation.type` maps to our pools via `ACTIVATION_MAP` in `const.mjs`.
Time-based types (`minute`, `hour`, `shortRest`, …) are listed in
`OUT_OF_COMBAT_ACTIVATIONS` and are dropped, not bucketed.

**The item's name and art lead on a button; the activity's own are the exception.** An
activity is one step inside a thing, not a better picture or a better name for it, and
both of its fields are traps: `GENERIC_ACTIVITY_NAMES` and `GENERIC_ACTIVITY_ICON` cover
dnd5e's per-type placeholders, but content that ships *real* activity art walks straight
past that guard — Fire Bolt and Eldritch Blast wore a generic beam on the bar while the
spell's own icon sat on the sheet. So `entryImage` and `activityLabel` both reach for the
activity only on a **split** button, where two buttons share one item's name and art and
the activity is the only thing telling them apart.

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
actor.system.spells   // spell1…spell9 {value,max} + pact {value,max,level}? (spells.mjs)
```

## Known open problems

Do not "fix" these casually — each needs a design decision.

- **Extra Attack.** Handled by `config.attacksPerAction` plus the per-entry `attacks`
  rule. The mixed monster Multiattack ("one bite *and* two claws") is deliberately
  **not** modelled any more: it only ever mattered for creatures that are no longer
  counted at all. If a *player-owned* creature ever needs it, that is a new design
  decision — and a dialog field, not a parser.
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
- When touching the economy or the booking path, state which of the four load-bearing
  decisions the change affects.
- Prefer extending the data tables in `const.mjs` over adding branches in logic files.
- If a change would need a new dependency, a build step, or a second write path, propose
  it before implementing.
