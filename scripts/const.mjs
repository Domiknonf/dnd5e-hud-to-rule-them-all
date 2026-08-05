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
 * Default number of "attack"-type activity uses that share a single action.
 * 1 = no Extra Attack. Per-actor override lives at
 * flags.dnd5e-hud-to-rule-them-all.config.attacksPerAction (see economy.mjs).
 */
export const DEFAULT_ATTACKS_PER_ACTION = 1;

export const DEBOUNCE_MS = 60;
