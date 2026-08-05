import { MODULE_ID, FLAGS, RESOURCES, DEFAULT_ATTACKS_PER_ACTION } from "./const.mjs";
import { requestFromGM } from "./socket.mjs";
import { guessAttacksPerAction } from "./actions.mjs";

/**
 * SINGLE SOURCE OF TRUTH: the economy lives in a flag on the Combatant document.
 * - Combatant flags are synced to every client for free.
 * - They die with the encounter, so no stale junk on the Actor.
 * - Players usually cannot write them -> writes are relayed to the active GM (socket.mjs).
 */

/** Debug/staleness marker so you can see in the flag which turn it belongs to. */
export function turnKey(combat) {
  return `${combat?.round ?? 0}:${combat?.turn ?? 0}`;
}

/** Maximum pool sizes for a combatant. Actor flag overrides world settings. */
export function getMaxima(combatant) {
  const actor = combatant?.actor;
  const override = actor?.getFlag?.(MODULE_ID, FLAGS.ACTOR_CONFIG)?.max ?? {};
  const legendary = Number(actor?.system?.resources?.legact?.max ?? 0);
  const base = {
    action: Number(game.settings.get(MODULE_ID, "maxAction")),
    bonus: Number(game.settings.get(MODULE_ID, "maxBonus")),
    reaction: Number(game.settings.get(MODULE_ID, "maxReaction")),
    free: Number(game.settings.get(MODULE_ID, "maxFree")),
    legendary,
    other: 0
  };
  return { ...base, ...override };
}

/**
 * How many "attack"-type activity uses share a single action this turn (Extra
 * Attack). Order: GM override (config.attacksPerAction) > best-effort guess from a
 * Multiattack-shaped feature's own description text (guessAttacksPerAction, see
 * actions.mjs - only reliable for "makes N attacks" phrasing, not mixed attacks
 * like "one bite and one claw") > default of 1 (no Extra Attack). PCs generally
 * need the override (Extra Attack is a class feature with no descriptive text to
 * parse); NPC Multiattack usually resolves on its own.
 */
export function getAttacksPerAction(combatant) {
  const actor = combatant?.actor;
  const override = actor?.getFlag?.(MODULE_ID, FLAGS.ACTOR_CONFIG)?.attacksPerAction;
  const n = Number(override);
  if (Number.isFinite(n) && n > 0) return n;
  return guessAttacksPerAction(actor) ?? DEFAULT_ATTACKS_PER_ACTION;
}

export function freshEconomy(combatant) {
  const used = {};
  for (const key of Object.keys(RESOURCES)) used[key] = 0;
  return {
    key: turnKey(combatant?.combat),
    used,
    max: getMaxima(combatant),
    dash: 0,          // number of extra movement pools bought with Dash
    attacksLeft: 0,    // remaining free "attack"-type uses within the current action
    log: []            // audit trail, newest last -> enables undo
  };
}

export function getEconomy(combatant) {
  const stored = combatant?.getFlag?.(MODULE_ID, FLAGS.ECONOMY);
  const fresh = freshEconomy(combatant);
  if (!stored) return fresh;
  // Always recompute maxima (level ups, effects, settings changes) but keep `used`.
  return foundry.utils.mergeObject(fresh, { ...stored, max: { ...fresh.max, ...(stored.max ?? {}) } }, { inplace: false });
}

export function remaining(combatant, type) {
  const econ = getEconomy(combatant);
  return (econ.max[type] ?? 0) - (econ.used[type] ?? 0);
}

export function canAfford(combatant, type, amount = 1) {
  if (!combatant) return true;
  if (type === "other" || type === null) return true;
  return remaining(combatant, type) >= amount;
}

/** Gate for "attack"-type activities: a queued Extra Attack is always affordable. */
export function canAttack(combatant) {
  if (!combatant) return true;
  const econ = getEconomy(combatant);
  if ((econ.attacksLeft ?? 0) > 0) return true;
  return canAfford(combatant, "action");
}

/**
 * Shared enforcement decision for both real activities (module.mjs's
 * dnd5e.preUseActivity) and the HUD's own intrinsic-action buttons (Dash aside -
 * it has its own dashCostsAction-driven check). Centralized so both call sites read
 * settings/gmBypass/affordability identically instead of drifting apart.
 * Returns "allow" | "warn" | "block".
 */
export function checkGate(combatant, type, { isAttack = false } = {}) {
  const mode = game.settings.get(MODULE_ID, "enforceActions");
  if (mode === "off") return "allow";
  if (!game.combat?.started) return "allow";
  if (game.user.isGM && game.settings.get(MODULE_ID, "gmBypass")) return "allow";
  if (!type || type === "other") return "allow";
  if (!combatant) return "allow";

  const affordable = isAttack ? canAttack(combatant) : canAfford(combatant, type);
  return affordable ? "allow" : mode;
}

async function write(combatant, econ) {
  return combatant.setFlag(MODULE_ID, FLAGS.ECONOMY, econ);
}

/** Spend from a pool. Safe to call as a player: falls back to a GM relay. */
export async function spend(combatant, type, { amount = 1, label = "", uuid = null } = {}) {
  if (!combatant || !RESOURCES[type]) return false;
  if (!combatant.isOwner || !canWriteFlags(combatant)) {
    return requestFromGM("spend", { combatantUuid: combatant.uuid, type, amount, label, uuid });
  }
  const econ = getEconomy(combatant);
  econ.used[type] = (econ.used[type] ?? 0) + amount;
  econ.key = turnKey(combatant.combat);
  econ.log = [...(econ.log ?? []), { type, amount, label, uuid, at: Date.now() }].slice(-40);
  await write(combatant, econ);
  return true;
}

/**
 * Book an "attack"-type activity use. Extra Attack lets several such uses share one
 * action: only the first spends the action pip, the rest draw down `attacksLeft`
 * (from getAttacksPerAction). Still funnels through the same flag write as spend()
 * - this is a second booking function, not a second write path (decision 3 intact).
 */
export async function spendAttack(combatant, { label = "", uuid = null } = {}) {
  if (!combatant) return false;
  if (!combatant.isOwner || !canWriteFlags(combatant)) {
    return requestFromGM("spendAttack", { combatantUuid: combatant.uuid, label, uuid });
  }
  const econ = getEconomy(combatant);
  const attacksLeftBefore = econ.attacksLeft ?? 0;
  let amount;
  if (attacksLeftBefore > 0) {
    econ.attacksLeft = attacksLeftBefore - 1;
    amount = 0;
  } else {
    econ.attacksLeft = Math.max(0, getAttacksPerAction(combatant) - 1);
    econ.used.action = (econ.used.action ?? 0) + 1;
    amount = 1;
  }
  econ.key = turnKey(combatant.combat);
  // attacksLeft snapshot (pre-spend) rides along so refund() can restore it exactly.
  econ.log = [...(econ.log ?? []), { type: "action", amount, label, uuid, attacksLeft: attacksLeftBefore, at: Date.now() }].slice(-40);
  await write(combatant, econ);
  return true;
}

/** Give back one pip (or the last logged entry if type is omitted). */
export async function refund(combatant, type = null, amount = 1) {
  if (!combatant) return false;
  if (!combatant.isOwner || !canWriteFlags(combatant)) {
    return requestFromGM("refund", { combatantUuid: combatant.uuid, type, amount });
  }
  const econ = getEconomy(combatant);
  const log = [...(econ.log ?? [])];
  if (!type) {
    const last = log.pop();
    if (!last) return false;
    type = last.type;
    amount = last.amount ?? 1;
    if (last.attacksLeft !== undefined) econ.attacksLeft = last.attacksLeft;
  }
  econ.used[type] = Math.max(0, (econ.used[type] ?? 0) - amount);
  econ.log = log;
  await write(combatant, econ);
  return true;
}

/** Buy an extra movement pool with the Dash action. */
export async function dash(combatant) {
  if (!combatant) return false;
  if (!combatant.isOwner || !canWriteFlags(combatant)) {
    return requestFromGM("dash", { combatantUuid: combatant.uuid });
  }
  const costsAction = game.settings.get(MODULE_ID, "dashCostsAction");
  if (costsAction && !canAfford(combatant, "action")) {
    ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notify.noAction`));
    return false;
  }
  const econ = getEconomy(combatant);
  econ.dash = (econ.dash ?? 0) + 1;
  if (costsAction) {
    econ.used.action = (econ.used.action ?? 0) + 1;
    econ.log = [...(econ.log ?? []), { type: "action", amount: 1, label: "Dash", at: Date.now() }].slice(-40);
  }
  await write(combatant, econ);
  return true;
}

/** Refill everything that resets at the start of a turn. */
export async function resetTurn(combatant) {
  if (!combatant) return false;
  if (!game.user.isActiveGM) return requestFromGM("resetTurn", { combatantUuid: combatant.uuid });
  const econ = freshEconomy(combatant);
  await write(combatant, econ);
  return true;
}

/**
 * Players own their Actor but usually not the Combatant document, so a direct
 * setFlag would throw. Cheap capability probe instead of guessing.
 */
export function canWriteFlags(combatant) {
  return game.user.isGM || combatant?.testUserPermission?.(game.user, "OWNER") === true;
}
