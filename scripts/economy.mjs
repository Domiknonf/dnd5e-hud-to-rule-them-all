import {
  MODULE_ID, FLAGS, RESOURCES, DEFAULT_ATTACKS_PER_ACTION,
  BLOCKING_CONDITIONS, EFFECT_POOL_BONUS, EFFECT_EXCLUSIVE_POOLS
} from "./const.mjs";
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

/** Effect names, normalised the same way item names are for the grant table. */
function effectNames(actor) {
  const effects = actor?.appliedEffects ?? actor?.effects ?? [];
  return [...effects].map(e =>
    (e?.name ?? "").trim().toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").trim()
  );
}

/**
 * The rules from a pattern table that this creature's effects currently match.
 *
 * One hit per RULE, not per effect: two copies of Haste are still one rule, which is
 * both what RAW says and what stops a doubled effect from doubling the pool.
 */
function matchedEffectRules(actor, table) {
  const names = effectNames(actor);
  if (!names.length) return [];
  return table.filter(rule => names.some(name => rule.match.test(name)));
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
  const max = { ...base, ...override };
  // Effects that change capacity while they last (Haste). Read off the creature
  // that HAS the effect, which is the only way to get it onto the right one.
  for (const rule of matchedEffectRules(actor, EFFECT_POOL_BONUS)) {
    for (const [pool, n] of Object.entries(rule.pools)) {
      max[pool] = Math.max(0, (max[pool] ?? 0) + n);
    }
  }
  return max;
}

/**
 * Pools this creature currently cannot use at all, because of a condition.
 *
 * Kept separate from the maxima on purpose: zeroing the max would make the pips
 * vanish, and an empty economy row reads as a broken bar rather than as "you are
 * Stunned". The pips stay, drawn as spent, and the bar says which condition did it.
 */
export function blockedPools(combatant) {
  const statuses = combatant?.actor?.statuses;
  const blocked = new Set();
  if (!statuses?.size) return blocked;
  for (const [status, pools] of Object.entries(BLOCKING_CONDITIONS)) {
    if (statuses.has(status)) for (const pool of pools) blocked.add(pool);
  }
  return blocked;
}

/** Which conditions are doing it, so the bar can name them. */
export function blockingConditions(combatant) {
  const statuses = combatant?.actor?.statuses;
  if (!statuses?.size) return [];
  return Object.keys(BLOCKING_CONDITIONS).filter(s => statuses.has(s));
}

/**
 * Whether `type` is barred because a pool it shares a budget with has already been
 * spent (Slow: an action or a Bonus Action, not both).
 */
export function coupledOut(combatant, type) {
  const rules = matchedEffectRules(combatant?.actor, EFFECT_EXCLUSIVE_POOLS)
    .filter(rule => rule.pools.includes(type));
  if (!rules.length) return false;
  const econ = getEconomy(combatant);
  return rules.some(rule =>
    rule.pools.some(pool => pool !== type && (econ.used[pool] ?? 0) > 0)
  );
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
  const granted = {};
  for (const key of Object.keys(RESOURCES)) { used[key] = 0; granted[key] = 0; }
  return {
    key: turnKey(combatant?.combat),
    used,
    // What a feature handed out this turn (Action Surge: one more action). Kept
    // apart from `max` because max is recomputed from settings on every read, and
    // folding it in there would either be lost or, once written back, counted twice.
    // A full map with zeros for the same reason usedTally is one: setFlag merges.
    granted,
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
  // The FRESH maxima win outright. Letting the stored ones override was the same
  // line, and it meant the opposite: max was frozen at whatever it happened to be
  // when the flag was last written, so a Haste landing mid-turn - or a level-up, or
  // a changed world setting - did not show until the next turn reset. Nothing ever
  // writes a max that getMaxima() cannot recompute, so there is nothing to preserve.
  return foundry.utils.mergeObject(fresh, { ...stored, max: fresh.max }, { inplace: false });
}

/**
 * A pool's size this turn: what the actor normally has, plus whatever a feature
 * granted. Read this rather than econ.max wherever a total is shown or compared -
 * econ.max is the baseline and does not know about Action Surge.
 */
export function poolMax(econ, type) {
  return (econ?.max?.[type] ?? 0) + (econ?.granted?.[type] ?? 0);
}

export function remaining(combatant, type) {
  const econ = getEconomy(combatant);
  return poolMax(econ, type) - (econ.used[type] ?? 0);
}

export function canAfford(combatant, type, amount = 1) {
  if (!combatant) return true;
  if (type === "other" || type === null) return true;
  if (blockedPools(combatant).has(type)) return false;
  if (coupledOut(combatant, type)) return false;
  return remaining(combatant, type) >= amount;
}

/** Gate for "attack"-type activities: a queued Extra Attack is always affordable. */
export function canAttack(combatant, key = null) {
  if (!combatant) return true;
  // Before the queued-attack shortcut below: a Stunned creature does not get to
  // finish the Multiattack it had started.
  if (blockedPools(combatant).has("action")) return false;
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

/**
 * Spend from a pool. Safe to call as a player: falls back to a GM relay.
 *
 * `grants` rides along rather than being its own call so that a feature which both
 * costs something and gives something (Action Surge costs a bonus action in the 2024
 * rules) is one write, not two.
 */
export async function spend(combatant, type, { amount = 1, label = "", uuid = null, grants = null } = {}) {
  if (!combatant || !RESOURCES[type]) return false;
  if (!combatant.isOwner || !canWriteFlags(combatant)) {
    return requestFromGM("spend", { combatantUuid: combatant.uuid, type, amount, label, uuid, grants });
  }
  const econ = getEconomy(combatant);
  const grantedBefore = applyGrants(econ, grants);
  econ.used[type] = (econ.used[type] ?? 0) + amount;
  econ.key = turnKey(combatant.combat);
  econ.log = [...(econ.log ?? []), { type, amount, label, uuid, granted: grantedBefore, at: Date.now() }].slice(-40);
  await write(combatant, econ);
  return true;
}

/**
 * Raise pools for the rest of the turn without spending anything. For a feature
 * that costs nothing at all (2014 Action Surge is a free action), where the spend
 * path above would never run.
 */
export async function grant(combatant, grants, { label = "", uuid = null } = {}) {
  if (!combatant || !grants) return false;
  if (!combatant.isOwner || !canWriteFlags(combatant)) {
    return requestFromGM("grant", { combatantUuid: combatant.uuid, grants, label, uuid });
  }
  const econ = getEconomy(combatant);
  const grantedBefore = applyGrants(econ, grants);
  if (!grantedBefore) return false;
  econ.key = turnKey(combatant.combat);
  econ.log = [...(econ.log ?? []), { type: null, amount: 0, label, uuid, granted: grantedBefore, at: Date.now() }].slice(-40);
  await write(combatant, econ);
  return true;
}

/** Fold a grant into the economy, returning the previous tally so refund can undo it. */
function applyGrants(econ, grants) {
  if (!grants) return undefined;
  const before = { ...(econ.granted ?? {}) };
  for (const [pool, n] of Object.entries(grants)) {
    if (!RESOURCES[pool] || !Number.isFinite(Number(n))) continue;
    econ.granted[pool] = (econ.granted[pool] ?? 0) + Number(n);
  }
  return before;
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
    if (last.granted !== undefined) econ.granted = last.granted;
  }
  // A grant-only entry (a feature that costs nothing but hands out an action) has no
  // pool to give back, and writing one would put a junk key into `used`.
  if (type) econ.used[type] = Math.max(0, (econ.used[type] ?? 0) - amount);
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
 * What the module currently believes about one creature's economy, for the console.
 *
 * Exists because "nothing happens" is otherwise unanswerable from outside: every
 * input here - which effects are applied, what their names normalise to, which
 * patterns matched, whether a Combatant was even found - lives in module-private
 * functions. Printing the inputs next to the outputs turns a guess into a reading.
 *
 * Reports rather than repairs: nothing here writes anything.
 */
export function diagnose(actor = null) {
  const subject = actor
    ?? canvas?.tokens?.controlled?.[0]?.actor
    ?? game.user?.character
    ?? null;
  const combatant = combatantFor(subject);
  // blockedPools/getMaxima only ever reach through to .actor, so a stand-in makes
  // the reading work outside an encounter too - where there IS no combatant, and
  // where the economy row is hidden by design rather than by a bug.
  const probe = combatant ?? (subject ? { actor: subject } : null);
  const econ = combatant ? getEconomy(combatant) : null;
  const rules = (table) => matchedEffectRules(subject, table).map(r => String(r.match));

  return {
    actor: subject?.name ?? "(none - select a token)",
    combatStarted: !!game.combat?.started,
    combatant: combatant?.name ?? "(none - not in the encounter)",
    isTheirTurn: !!combatant && game.combat?.combatant?.id === combatant.id,
    // What an action costs RIGHT NOW. "reaction" here means off-turn.
    actionCostsNow: poolForNow(combatant, "action"),

    statuses: [...(subject?.statuses ?? [])],
    effects: [...(subject?.appliedEffects ?? subject?.effects ?? [])].map(e => e?.name),
    effectsAsMatched: effectNames(subject),
    matchedPoolBonus: rules(EFFECT_POOL_BONUS),
    matchedExclusive: rules(EFFECT_EXCLUSIVE_POOLS),

    maxima: probe ? getMaxima(probe) : null,
    blockedByCondition: probe ? [...blockedPools(probe)] : [],
    used: econ?.used ?? null,
    grantedThisTurn: econ?.granted ?? null,
    attacksLeft: econ?.attacksLeft ?? null,
    multiattack: econ?.multiattack ?? null
  };
}

/**
 * Players own their Actor but usually not the Combatant document, so a direct
 * setFlag would throw. Cheap capability probe instead of guessing.
 */
export function canWriteFlags(combatant) {
  return game.user.isGM || combatant?.testUserPermission?.(game.user, "OWNER") === true;
}
