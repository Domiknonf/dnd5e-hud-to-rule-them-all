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

/** Upper bounds for the config dialog's number inputs. Sanity rails, not rules. */
export const CONFIG_LIMITS = {
  attacksPerAction: { min: 1, max: 10 },
  poolMax: { min: 0, max: 9 }
};

export const DEBOUNCE_MS = 60;
