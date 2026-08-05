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
 * action / bonus action / reaction / free object interaction).
 */
export const RESOURCES = {
  action:    { icon: "fa-solid fa-hand-fist",     perTurn: true,  order: 10 },
  bonus:     { icon: "fa-solid fa-bolt",          perTurn: true,  order: 20 },
  reaction:  { icon: "fa-solid fa-reply",         perTurn: true,  order: 30 },
  free:      { icon: "fa-solid fa-hand-pointer",  perTurn: true,  order: 40 },
  legendary: { icon: "fa-solid fa-crown",         perTurn: true,  order: 50 },
  other:     { icon: "fa-solid fa-ellipsis",      perTurn: false, order: 90 }
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
 * Actions every creature has, which are not items on the sheet.
 * `handler` maps to a case in hud.mjs -> #onIntrinsic.
 */
export const INTRINSIC_ACTIONS = [
  { id: "dash",       type: "action",   icon: "fa-solid fa-person-running", handler: "dash" },
  { id: "disengage",  type: "action",   icon: "fa-solid fa-shoe-prints",    handler: "spendOnly" },
  { id: "dodge",      type: "action",   icon: "fa-solid fa-shield-halved",  handler: "spendOnly" },
  { id: "hide",       type: "action",   icon: "fa-solid fa-eye-slash",      handler: "skill", skill: "ste" },
  { id: "search",     type: "action",   icon: "fa-solid fa-magnifying-glass", handler: "skill", skill: "prc" },
  { id: "influence",  type: "action",   icon: "fa-solid fa-comments",       handler: "spendOnly" },
  { id: "study",      type: "action",   icon: "fa-solid fa-book",           handler: "spendOnly" },
  { id: "utilize",    type: "action",   icon: "fa-solid fa-hand",           handler: "spendOnly" },
  { id: "ready",      type: "action",   icon: "fa-solid fa-hourglass-half", handler: "spendOnly" },
  { id: "shove",      type: "action",   icon: "fa-solid fa-hand-back-fist", handler: "spendOnly" },
  { id: "grapple",    type: "action",   icon: "fa-solid fa-handshake",      handler: "spendOnly" },
  { id: "offhand",    type: "bonus",    icon: "fa-solid fa-hand-sparkles",  handler: "spendOnly" },
  { id: "opportunity",type: "reaction", icon: "fa-solid fa-crosshairs",     handler: "spendOnly" },
  { id: "interact",   type: "free",     icon: "fa-solid fa-arrow-pointer",  handler: "spendOnly" }
];

export const DEBOUNCE_MS = 60;
