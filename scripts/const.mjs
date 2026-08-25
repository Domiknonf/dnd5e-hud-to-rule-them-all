/** Central constants and data tables. Keep runtime-verifiable assumptions in ONE place. */

export const MODULE_ID = "dnd5e-hud-to-rule-them-all";
export const SOCKET = `module.${MODULE_ID}`;

export const FLAGS = {
  ECONOMY: "economy",     // stored on the Combatant document
  ACTOR_CONFIG: "config"  // per-actor overrides, stored on the Actor
};

/**
 * The resource pools the HUD tracks. Order = display order.
 * `perTurn: true` means the pool is refilled when the owner's turn starts (RAW for
 * action / bonus action / reaction).
 */
export const RESOURCES = {
  action:    { icon: "fa-solid fa-hand-fist",     perTurn: true,  order: 10 },
  bonus:     { icon: "fa-solid fa-bolt",          perTurn: true,  order: 20 },
  reaction:  { icon: "fa-solid fa-reply",         perTurn: true,  order: 30 },
  legendary: { icon: "fa-solid fa-crown",         perTurn: true,  order: 50 },
  other:     { icon: "fa-solid fa-ellipsis",      perTurn: false, order: 90 },
  // Not a real pool: max stays 0 (never shows pips, never exhausts, costs
  // nothing). Exists so passive features get a HUD section like any other bucket.
  passive:   { icon: "fa-solid fa-book-open",     perTurn: false, order: 95 }
};

/**
 * The pool keys in display order, resolved once at load.
 *
 * Every render walked RESOURCES and sorted it by `order` two or three times over -
 * for the pips, for the groups and again for the grid. The table is a module
 * constant, so the answer is too.
 */
export const POOL_ORDER = Object.keys(RESOURCES).sort((a, b) => RESOURCES[a].order - RESOURCES[b].order);

/**
 * SECTIONS: the second level of grouping, INSIDE one pool. A caster's Action group is
 * twenty-odd buttons, and "which of these is a spell" is a question the player answers
 * by eye every single turn - so the bar answers it instead, and each section can be
 * folded away when it is not this turn's business (see hud.mjs).
 *
 * Derived from `item.type`, which the SYSTEM states outright. That is why there is no
 * config counterpart here the way there is for pools: nothing about it is a guess, so
 * there is nothing for anyone to correct. Where an entry sits WITHIN its section is
 * still the `sort` rule from the gear dialog.
 *
 * Order = display order inside the group.
 */
export const SECTIONS = {
  weapon:     { icon: "fa-solid fa-gavel",         order: 10 },
  spell:      { icon: "fa-solid fa-wand-sparkles", order: 20 },
  feature:    { icon: "fa-solid fa-star",          order: 30 },
  consumable: { icon: "fa-solid fa-flask",         order: 40 },
  gear:       { icon: "fa-solid fa-toolbox",       order: 50 }
};

/**
 * dnd5e item type -> section. Anything unlisted (equipment, tool, loot, a homebrew
 * type) falls through to DEFAULT_SECTION, which is why `gear` is ordered last: it is
 * the leftovers drawer.
 */
export const ITEM_TYPE_SECTIONS = {
  weapon: "weapon",
  spell: "spell",
  consumable: "consumable",
  // Everything a creature simply HAS. dnd5e spreads these over five item types that
  // all read as "a feature" on the sheet; keeping them apart on the bar as well would
  // buy sections of one entry each.
  feat: "feature",
  race: "feature",
  class: "feature",
  subclass: "feature",
  background: "feature"
};

export const DEFAULT_SECTION = "gear";

/**
 * Below this many entries a group stays one plain grid. Sections cost a chip in the
 * header and a divider per section, which under a handful of buttons is more furniture
 * than the clutter it removes. Sized against the bar this was built for: an Action
 * group of twenty-odd entries splits, the Bonus Action group of three beside it
 * does not.
 */
export const SECTION_MIN_ENTRIES = 8;

/**
 * Above this many slots at one level, the strip stops drawing a pip per slot and falls
 * back to "3/4". Pips answer "how many do I have left" without reading anything, which
 * is the whole point - but a row of fifteen of them is a number again, only harder to
 * read and wide enough to push the strip around. 5e never goes past four, so this is a
 * guard against homebrew and effects, not a case anybody meets.
 */
export const SPELL_PIP_LIMIT = 6;

/**
 * How many death saving throws it takes either way. Three and three - not a table to
 * extend, it is the rules, the same reason spells.mjs stops at level 9.
 */
export const DEATH_SAVE_PIPS = 3;

/**
 * Where a pinned description card is allowed to sit, in CSS pixels (see hud.mjs
 * #placeCard).
 *
 * `margin` is the gap it keeps from the slot it belongs to and from every screen
 * edge. `minHeight` is the floor: on a viewport too short to fit anything worth
 * reading above the slot, the card is allowed to overlap the bar rather than be
 * squeezed into a two-line letterbox - a card covering some buttons is recoverable
 * (click it away), a card too small to read is not.
 */
export const DESC_CARD = { margin: 8, minHeight: 220 };

/**
 * How far right the played creature's grid may run, in cells. Positions are absolute
 * cell numbers (see hud.mjs gridCells), and every cell up to the last occupied one is
 * a real element - so a nonsense number in a hand-edited flag would ask the browser
 * for that many. Nothing arranged by hand comes near this: at two rows it is fifty
 * columns, far past anything a bar can show at once. A button past the limit is
 * treated as unplaced and lands at the end.
 */
export const GRID_CELL_LIMIT = 100;

/**
 * How many slot rows the played-creature grid may have, and what it starts with. BG3
 * puts `+` and `-` next to End Turn for exactly this; two rows is what fits under a
 * portrait without the bar growing taller than it already is.
 */
export const GRID_ROWS = { min: 1, max: 4, default: 2 };

/**
 * The category tabs above that grid, in order. `passive` is last and deliberately
 * included: passives are not actions and have no business filling hotbar slots, but
 * they are still the answer to "what does this creature have", so they get a tab
 * rather than a permanent row. Keys are SECTIONS keys plus "passive", so both come out
 * of the same table and nothing here needs its own label.
 */
export const GRID_TABS = ["weapon", "spell", "feature", "consumable", "gear", "passive"];

/**
 * The tab that leads the strip and stands for "no filter at all". Not a SECTIONS key
 * and never stored as one: the unfiltered grid IS the null category, so this tab only
 * ever clears - which is also what makes it light up on its own the moment another
 * tab is clicked off.
 */
export const ALL_TAB = "all";

/**
 * dnd5e activation type -> our bucket.
 * VERIFY AT RUNTIME: `Object.keys(CONFIG.DND5E.activityActivationTypes)` in the console.
 * Anything not listed here and not purely time-based lands in "other" (see actions.mjs).
 */
export const ACTIVATION_MAP = {
  action: "action",
  bonus: "bonus",
  reaction: "reaction",
  legendary: "legendary",
  mythic: "legendary",
  lair: "legendary",
  crew: "other",
  special: "other"
};

/** Activation types that are never combat-relevant and should be hidden by default. */
export const OUT_OF_COMBAT_ACTIVATIONS = new Set([
  "minute", "hour", "day", "month", "year",
  "shortRest", "longRest", "encounter", "turnStart", "turnEnd"
]);

/**
 * PC features whose use GRANTS pool capacity for the rest of the turn, by item name,
 * as `{ pool: amount }`.
 *
 * Same reasoning and the same limits as PC_EXTRA_ATTACK_NAMES: a small, fixed
 * English SRD vocabulary that only ever appears on Player Characters, so a name
 * lookup beats parsing freeform text. It is only the DEFAULT - the per-entry
 * `grants` rule overrides it, which is what homebrew and translated content need.
 *
 * Deliberately short. Haste is not here: its extra action is restricted to a few
 * specific actions and it arrives as an effect on a target rather than as a use, so
 * granting a full action for it would be wrong in the common case.
 */
export const ACTION_GRANT_NAMES = {
  "action surge": { action: 1 }
};

/**
 * Item names whose activities may REPLACE one attack within the Attack action
 * (2024 rules: the Dragonborn's Breath Weapon explicitly substitutes for one of
 * the attacks). Matched on the ITEM name, not the activity, because such traits
 * typically carry several non-attack activities (Breath Weapon: Cone + Line, both
 * "save"-type) that collapse into a single item-level HUD button. Restricted to
 * character actors in isAttackSubstituteItem() - NPC breath weapons are their own
 * full action, not a substitute. English SRD naming; homebrew needs its own entry.
 */
export const ATTACK_SUBSTITUTE_NAMES = new Set(["breath weapon"]);

/**
 * dnd5e seeds activity.img with a generic per-type placeholder
 * (systems/dnd5e/icons/svg/activity/<type>.svg) whenever nobody set a custom icon.
 * Same trap as the activity-name fallback: never trust it over the item's own art.
 */
export const GENERIC_ACTIVITY_ICON = /^systems\/dnd5e\/icons\/svg\/activity\//;

/**
 * Activity names that say nothing about the activity - they are the per-type
 * fallback, not something a person typed. The name twin of GENERIC_ACTIVITY_ICON,
 * and the same trap: they are truthy, so they happily shadow the item's real name.
 *
 * VERIFIED IN A LIVE WORLD: with Midi QoL active, every wrapped activity reports
 * `name: "Midi Attack"` (a Greatsword's attack arrived as exactly that), which put
 * "Greatsword - Midi Attack" in the config dialog and in the economy log for every
 * weapon on the sheet. dnd5e's own fallback is the bare type label.
 *
 * Matched case-insensitively against the whole name, so a real activity someone
 * deliberately called "Attack of Opportunity" is untouched.
 */
export const GENERIC_ACTIVITY_NAMES = new Set([
  "attack", "damage", "save", "check", "heal", "utility", "summon", "enchant",
  "cast", "order", "forward", "midi attack", "midi damage", "midi save", "midi other"
]);

/**
 * Default number of "attack"-type activity uses that share a single action.
 * 1 = no Extra Attack. Per-actor override lives at
 * flags.dnd5e-hud-to-rule-them-all.config.attacksPerAction (see config.mjs).
 */
export const DEFAULT_ATTACKS_PER_ACTION = 1;

/**
 * Pools whose size the per-actor config dialog may override, mapped to the world
 * setting that supplies the fallback. Only the three pools that HAVE a world
 * default are listed: `legendary` is derived from the actor's own
 * system.resources.legact.max (overriding it here would fight the sheet), and
 * `other`/`passive` have no budget at all.
 */
export const CONFIGURABLE_POOLS = {
  action:   { setting: "maxAction" },
  bonus:    { setting: "maxBonus" },
  reaction: { setting: "maxReaction" }
};

/**
 * Pools an individual entry may be reassigned to in the config dialog, overriding
 * ACTIVATION_MAP. Order = display order in the dropdown. `passive` is missing on
 * purpose: it is not a pool but the bucket for features that cannot be used at all,
 * and moving a usable activity there would hide it from booking entirely - that is
 * what the per-entry "hidden" flag is for.
 */
export const ASSIGNABLE_POOLS = ["action", "bonus", "reaction", "legendary", "other"];

/**
 * Zone key in the config dialog for "not on the bar". Not a pool and never stored as
 * one - dropping into it writes `hidden`. It collects both what was hidden by hand
 * and what has no pool at all (out-of-combat activations), because both answer the
 * same question and both are undone the same way: drag it into a pool.
 */
export const HIDDEN_ZONE = "hidden";

/**
 * Conditions that take the economy away, and which pools each one takes.
 *
 * 2024 rules: Incapacitated bars the action, the Bonus Action AND the Reaction, and
 * a creature that cannot act cannot take Legendary Actions either. Every condition
 * below contains Incapacitated, so they all say the same thing - they are listed one
 * by one anyway because dnd5e does not reliably propagate the rider status onto
 * `actor.statuses`, and matching "incapacitated" alone would miss a plain Stunned.
 *
 * Matched against `actor.statuses` (Foundry's status ids), not effect names, so it
 * works no matter which module applied the condition.
 */
export const BLOCKING_CONDITIONS = {
  incapacitated: ["action", "bonus", "reaction", "legendary"],
  stunned:       ["action", "bonus", "reaction", "legendary"],
  paralyzed:     ["action", "bonus", "reaction", "legendary"],
  unconscious:   ["action", "bonus", "reaction", "legendary"],
  petrified:     ["action", "bonus", "reaction", "legendary"]
};

/**
 * Active effects that CHANGE pool sizes while they last. Deltas, added on top of
 * whatever the creature normally has.
 *
 * PATTERNS, not exact names, because nothing agrees on the name: dnd5e's own spell
 * effect is "Haste", DAE and Midi SRD content ship "Hasted", and a concentration
 * marker may hang a parenthetical on either (stripped before matching).
 *
 * ANCHORED patterns, though - not a loose /haste/ or /slow/. A substring match on
 * "slow" also matches the Monk's **Slow Fall**, which would quietly couple that
 * character's action and Bonus Action for the rest of the fight, and nothing about
 * the bar would explain why. Anchoring costs one alternative per spelling and buys
 * back the whole class of accidental matches.
 *
 * Haste belongs here and NOT in ACTION_GRANT_NAMES: it is an effect on a target, so
 * booking it when the spell is used would hand the extra action to the caster, who
 * is usually not the one who gets it. Read from the target's effects, it lands on
 * the right creature and it ends when the spell does.
 *
 * The extra action is restricted (Dash, Disengage, Hide, Utilize, or one attack) and
 * nothing here enforces that - the bar counts pips, it does not police which button
 * fills them. Nor does it stack: two Hastes are still one rule, which is also RAW.
 */
export const EFFECT_POOL_BONUS = [
  { match: /^hast(e|ed)$/, pools: { action: 1 } }
];

/**
 * Effects under which several pools share ONE budget: spending any of them spends
 * the lot. 2024 Slow - "it can take either an action or a Bonus Action on its turn,
 * not both" - which is not a smaller pool but a coupling between two, and there is
 * no way to say that with maxima alone. Same anchoring rule as above.
 */
export const EFFECT_EXCLUSIVE_POOLS = [
  { match: /^slow(ed)?$/, pools: ["action", "bonus"] }
];

/**
 * Effects that take a pool away outright, the effect-name twin of
 * BLOCKING_CONDITIONS. Same anchoring rule as the two tables above.
 *
 * Slow is in BOTH tables because the spell does two separate things: it couples the
 * action and the Bonus Action ("either an action or a Bonus Action, not both") AND
 * it bars Reactions. Modelling only the coupling - as this did at first - left a
 * Slowed creature happily taking Opportunity Attacks.
 *
 * VERIFY AGAINST YOUR PHB: the "can't take Reactions" clause is certain in the 2014
 * text and read as unchanged for 2024 here. It is one line to remove if that is wrong.
 */
export const EFFECT_BLOCKED_POOLS = [
  { match: /^slow(ed)?$/, pools: ["reaction"] }
];

/** Upper bounds for the config dialog's number inputs. Sanity rails, not rules. */
export const CONFIG_LIMITS = {
  attacksPerAction: { min: 1, max: 10 },
  poolMax: { min: 0, max: 9 }
};

export const DEBOUNCE_MS = 60;
