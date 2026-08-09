import { MODULE_ID, FLAGS, RESOURCES, DEFAULT_ATTACKS_PER_ACTION } from "./const.mjs";
import { requestFromGM } from "./socket.mjs";
import { getActorConfig } from "./config.mjs";
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

/**
 * The combatant an actor is fighting as, or null. Lives here because two callers
 * need the exact same answer: the booking path (module.mjs) and the HUD, which has
 * to show the bar's subject their OWN economy rather than the acting creature's.
 *
 * actor.id alone collides for unlinked tokens sharing one prototype (five identical
 * goblins), so the token is matched first.
 */
export function combatantFor(actor) {
  if (!actor || !game.combat) return null;
  const tokenId = actor.token?.id ?? actor.getActiveTokens?.(false, true)?.[0]?.id;
  return game.combat.combatants.find(c => c.tokenId === tokenId)
      ?? game.combat.combatants.find(c => c.actor?.uuid === actor.uuid)
      ?? null;
}

/**
 * The pool a use actually draws from RIGHT NOW, which is not always the one the
 * activity declares.
 *
 * OFF-TURN, AN ACTION-COST ACTIVITY IS A REACTION. 5e has no way to take the Attack
 * action on somebody else's turn, so a weapon swung there is an Opportunity Attack
 * or a readied one, and both are reactions. Nothing in the system marks an
 * Opportunity Attack as such - the sheet, a macro and Midi all fire the same
 * activity, still declaring activation "action" - so whose turn it is is the only
 * signal available, and for this question it is a reliable one.
 *
 * Deliberately narrow. Only `action` moves:
 * - `legendary` and `lair` are off-turn BY DESIGN and must keep their own pools.
 * - `bonus` has no off-turn form worth guessing at.
 * - `reaction` is already right.
 * - `other`/null are free anyway.
 *
 * Consequence worth knowing: a GM who fires a monster's ability while it is not
 * that monster's turn books a reaction for it. That is what the rules say it is.
 */
export function poolForNow(combatant, type) {
  if (type !== "action") return type;
  if (!combatant || !game.combat?.started) return type;
  return game.combat.combatant?.id === combatant.id ? type : "reaction";
}

/** Maximum pool sizes for a combatant. Actor flag overrides world settings. */
export function getMaxima(combatant) {
  const actor = combatant?.actor;
  const override = getActorConfig(actor).max ?? {};
  const legendary = Number(actor?.system?.resources?.legact?.max ?? 0);
  const base = {
    action: Number(game.settings.get(MODULE_ID, "maxAction")),
    bonus: Number(game.settings.get(MODULE_ID, "maxBonus")),
    reaction: Number(game.settings.get(MODULE_ID, "maxReaction")),
    legendary,
    other: 0,
    passive: 0
  };
  return { ...base, ...override };
}

/**
 * How many "attack"-type activity uses share a single action this turn (Extra
 * Attack). Order: what was configured for this actor (config.mjs, set by the owner
 * or the GM in the HUD's gear dialog) > best-effort suggestion from a
 * Multiattack-shaped feature's own description text (guessAttacksPerAction, see
 * actions.mjs - only reliable for "makes N attacks" phrasing, not mixed attacks
 * like "one bite and one claw") > default of 1 (no Extra Attack).
 *
 * The suggestion stays in the chain on purpose even though configuration is the
 * intended path now: it is what keeps a freshly dropped pack of NPCs correct
 * without configuring each statblock first, and NPC statblocks are exactly where
 * the text parsing works. Player characters are the opposite case - Extra Attack
 * is a class feature with no parseable text - so those get configured by hand.
 */
export function getAttacksPerAction(combatant) {
  const actor = combatant?.actor;
  const n = Number(getActorConfig(actor).attacksPerAction);
  if (Number.isFinite(n) && n > 0) return n;
  return guessAttacksPerAction(actor)?.count ?? DEFAULT_ATTACKS_PER_ACTION;
}

/* ------------------------------------------------------------------ */
/*  Multiattack                                                        */
/* ------------------------------------------------------------------ */

/**
 * The configured Multiattack, or null. Shape:
 *   options: [ { parts: [ { key, count } ] } ]
 * One option is one alternative (pick exactly one); several parts inside an option
 * are combined ("one bite AND two claws").
 */
export function multiattackOptions(combatant) {
  const options = getActorConfig(combatant?.actor).multiattack?.options;
  return Array.isArray(options) && options.length ? options : null;
}

const partCount = (option, key) => option?.parts?.find(p => p.key === key)?.count ?? 0;

/**
 * A tally carrying a slot for EVERY key the Multiattack mentions, zeros included.
 *
 * This is not cosmetic. write() goes through setFlag, which merges recursively, so
 * an object that lost a key between two writes keeps the value it dropped. `used` is
 * the only part of the economy that shrinks - a fresh Attack action starts a new
 * tally - so without the zeros the first swing of the second action inherits the
 * first action's, and every alternative gets ruled out at once (viableOptions
 * returns nothing, every badge reads 0 and the whole Attack pool locks up).
 *
 * Zeros are inert everywhere they are read: viableOptions asks `>= 0`, which every
 * option satisfies, and attacksRemaining subtracts nothing.
 */
function usedTally(options, used = {}) {
  const tally = {};
  for (const option of options ?? []) {
    for (const part of option?.parts ?? []) if (part?.key) tally[part.key] = 0;
  }
  for (const [key, n] of Object.entries(used)) if (key) tally[key] = n;
  return tally;
}

/**
 * The options still consistent with what has already been used this action.
 *
 * This is what makes the whole thing work WITHOUT asking which Multiattack the
 * player intends: every option stays open until a use rules it out. Given "two A"
 * or "one A and one B", clicking A leaves both alive; a second A kills the second
 * option, a B kills the first. The bar just shows what is still possible.
 */
function viableOptions(options, used) {
  return options.filter(option =>
    Object.entries(used ?? {}).every(([key, n]) => partCount(option, key) >= n)
  );
}

/**
 * How many more times this entry may be used inside the CURRENT Attack action.
 * With no action in progress this is the best any option offers, which is what the
 * bar promises before the first swing.
 */
export function attacksRemaining(combatant, key) {
  const options = multiattackOptions(combatant);
  if (!options || !key) return null;
  const used = getEconomy(combatant).multiattack?.used ?? null;
  if (!used) return Math.max(0, ...options.map(o => partCount(o, key)));
  return Math.max(0, ...viableOptions(options, used).map(o => partCount(o, key) - (used[key] ?? 0)));
}

/**
 * The most this entry could ever contribute to one Attack action - the best any
 * option offers. The bar needs it as the badge's denominator; attacksRemaining()
 * alone would only ever say "n of n".
 */
export function attackCapacity(combatant, key) {
  const options = multiattackOptions(combatant);
  if (!options || !key) return null;
  return Math.max(0, ...options.map(o => partCount(o, key)));
}

export function freshEconomy(combatant) {
  const used = {};
  for (const key of Object.keys(RESOURCES)) used[key] = 0;
  return {
    key: turnKey(combatant?.combat),
    used,
    max: getMaxima(combatant),
    attacksLeft: 0,    // remaining free "attack"-type uses within the current action
    multiattack: null, // { used: { entryKey: n } } while a configured Multiattack runs
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
export function canAttack(combatant, key = null) {
  if (!combatant) return true;
  const econ = getEconomy(combatant);
  if (multiattackOptions(combatant)) {
    // Mid-Multiattack, only what a surviving option still allows is free; anything
    // else has to open a fresh Attack action and pay for it.
    if (econ.multiattack && (attacksRemaining(combatant, key) ?? 0) > 0) return true;
    return canAfford(combatant, "action");
  }
  if ((econ.attacksLeft ?? 0) > 0) return true;
  return canAfford(combatant, "action");
}

/**
 * Enforcement decision for activity usage (module.mjs's dnd5e.preUseActivity).
 * Returns "allow" | "warn" | "block".
 */
export function checkGate(combatant, type, { isAttack = false, key = null } = {}) {
  const mode = game.settings.get(MODULE_ID, "enforceActions");
  if (mode === "off") return "allow";
  if (!game.combat?.started) return "allow";
  if (game.user.isGM && game.settings.get(MODULE_ID, "gmBypass")) return "allow";
  if (!type || type === "other") return "allow";
  if (!combatant) return "allow";

  const affordable = isAttack ? canAttack(combatant, key) : canAfford(combatant, type);
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
 * - this is a second booking function, not a second write path (decision 2 intact).
 */
export async function spendAttack(combatant, { label = "", uuid = null, attacks = null, key = null } = {}) {
  if (!combatant) return false;
  if (!combatant.isOwner || !canWriteFlags(combatant)) {
    return requestFromGM("spendAttack", { combatantUuid: combatant.uuid, label, uuid, attacks, key });
  }
  const econ = getEconomy(combatant);
  const attacksLeftBefore = econ.attacksLeft ?? 0;
  const multiattackBefore = econ.multiattack ? foundry.utils.deepClone(econ.multiattack) : null;
  let amount;

  const options = multiattackOptions(combatant);
  if (options) {
    // A configured Multiattack replaces the plain counter entirely: instead of a
    // remaining total, the state is what has been used, and the options narrow
    // themselves down as it grows.
    const free = econ.multiattack && (attacksRemaining(combatant, key) ?? 0) > 0;
    if (free) {
      econ.multiattack = { used: usedTally(options, { ...econ.multiattack.used, [key]: (econ.multiattack.used?.[key] ?? 0) + 1 }) };
      amount = 0;
    } else {
      econ.multiattack = { used: usedTally(options, key ? { [key]: 1 } : {}) };
      econ.used.action = (econ.used.action ?? 0) + 1;
      amount = 1;
    }
    econ.key = turnKey(combatant.combat);
    econ.log = [...(econ.log ?? []), { type: "action", amount, label, uuid, attacksLeft: attacksLeftBefore, multiattack: multiattackBefore, at: Date.now() }].slice(-40);
    await write(combatant, econ);
    return true;
  }

  if (attacksLeftBefore > 0) {
    econ.attacksLeft = attacksLeftBefore - 1;
    amount = 0;
  } else {
    // The entry that OPENS the action decides how many it grants - that is what
    // makes "two Holy Bursts or three Radiant Swords" expressible. Without one, the
    // actor-wide number applies.
    const total = Number.isFinite(attacks) && attacks > 0 ? attacks : getAttacksPerAction(combatant);
    econ.attacksLeft = Math.max(0, total - 1);
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
    if (last.multiattack !== undefined) econ.multiattack = last.multiattack;
  }
  econ.used[type] = Math.max(0, (econ.used[type] ?? 0) - amount);
  econ.log = log;
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
