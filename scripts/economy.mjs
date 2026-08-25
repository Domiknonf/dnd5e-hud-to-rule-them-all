import {
  MODULE_ID, FLAGS, RESOURCES, DEFAULT_ATTACKS_PER_ACTION,
  BLOCKING_CONDITIONS, EFFECT_POOL_BONUS, EFFECT_EXCLUSIVE_POOLS, EFFECT_BLOCKED_POOLS
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
 * Whether this creature's action economy is TRACKED at all - booked, gated, and
 * drawn as pips. False means the bar is a pure ability launcher for it: the groups,
 * the pool sections and the per-entry configuration all stay, nothing is counted.
 *
 * KEYED ON OWNERSHIP, NOT ON actor.type. The bar exists to help the person playing a
 * creature keep track of what it can still do, and that person is not the GM: they
 * already know a goblin has one action, they read the Multiattack off the statblock
 * in front of them, and with `gmBypass` on (the default) the gate never stopped them
 * anyway - so for GM creatures the pips were bookkeeping nobody read, paid for with a
 * Combatant flag write per monster attack and a re-render on every client.
 *
 * `hasPlayerOwner` asks the question that actually matters. A wildshaped druid, a
 * summoned drake and a sidekick are all `npc` actors that a player is playing, and
 * those are exactly the ones that still need counting; an actor.type check would
 * have taken the bar away from them along with the goblins.
 *
 * THE ESCAPE HATCH: `trackEveryone` counts every creature regardless, which is what
 * the module did before 0.5.0. Default off, so the reasoning above stays the default
 * behaviour and nobody pays for monster bookkeeping they never read. It exists for
 * two cases that are real: testing on a GM-owned character (where "why are there no
 * pips" is the first thing that happens), and a table that simply wants the GM's
 * monsters counted too. Being a WORLD setting is deliberate - whether a creature is
 * counted decides what gets written to its Combatant flag, and two clients disagreeing
 * about that would book the same attack differently.
 */
export function isTracked(actor) {
  if (!actor) return false;
  if (game.settings.get(MODULE_ID, "trackEveryone") === true) return true;
  return isPlayed(actor);
}

/**
 * Does somebody PLAY this creature? The same question isTracked asks, minus the
 * testing escape hatch - and the split matters.
 *
 * This is the switch for the bar's LAYOUT: a played creature gets the BG3 model (a
 * fixed grid you arrange once, with the pool as a marker on each slot), a GM-only
 * creature gets the auto-grouped bar it has always had. Nobody is going to arrange
 * twelve goblins by hand, and everybody arranges their own character.
 *
 * It must NOT read `trackEveryone`: that setting exists so a GM can count monsters
 * while testing, and it would be absurd for a counting switch to hand every goblin a
 * layout that expects to be curated. Counting and layout ask the same question; only
 * counting has an override.
 */
export function isPlayed(actor) {
  return actor?.hasPlayerOwner === true;
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

const normaliseName = (name) =>
  (name ?? "").trim().toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").trim();

const activeEffects = (actor) => [...(actor?.appliedEffects ?? actor?.effects ?? [])];

/** Effect names, normalised the same way item names are for the grant table. */
function effectNames(actor) {
  return activeEffects(actor).map(e => normaliseName(e?.name));
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
  const actor = combatant?.actor;
  const blocked = new Set();
  const statuses = actor?.statuses;
  if (statuses?.size) {
    for (const [status, pools] of Object.entries(BLOCKING_CONDITIONS)) {
      if (statuses.has(status)) for (const pool of pools) blocked.add(pool);
    }
  }
  // Effects bar pools too, and not always the same ones a condition would: Slow
  // takes the Reaction while leaving the action and the Bonus Action coupled.
  for (const rule of matchedEffectRules(actor, EFFECT_BLOCKED_POOLS)) {
    for (const pool of rule.pools) blocked.add(pool);
  }
  return blocked;
}

/** What is doing it, so the bar can name it: condition ids, then effect names. */
export function blockingConditions(combatant) {
  const actor = combatant?.actor;
  const statuses = actor?.statuses;
  const conditions = statuses?.size
    ? Object.keys(BLOCKING_CONDITIONS).filter(s => statuses.has(s))
    : [];
  // For an effect, the sheet's own wording is the clearest thing to show back.
  const effects = activeEffects(actor)
    .filter(e => EFFECT_BLOCKED_POOLS.some(r => r.match.test(normaliseName(e?.name))))
    .map(e => e?.name);
  return [...conditions, ...effects];
}

/**
 * Every pool currently sharing a budget with another, whether or not anything has
 * been spent yet.
 *
 * Separate from coupledOut() because the bar has to show the coupling BEFORE it
 * bites. coupledOut only turns true once one of the pair is gone, so on its own a
 * Slowed creature looked exactly like an unaffected one right up to the moment the
 * Bonus Action silently stopped working.
 */
export function coupledPools(combatant) {
  const pools = new Set();
  for (const rule of matchedEffectRules(combatant?.actor, EFFECT_EXCLUSIVE_POOLS)) {
    for (const pool of rule.pools) pools.add(pool);
  }
  return pools;
}

/**
 * Every pool barred right now because a pool it shares a budget with has already
 * been spent (Slow: an action or a Bonus Action, not both).
 *
 * Answers for ALL pools in one pass. The bar asks this per pool, twice over - once
 * for the pips and once for the group that greys out - and doing it one pool at a
 * time re-matched the effect tables and re-read the economy for each of them.
 * Takes an economy if the caller already has one, which the HUD does.
 */
export function coupledOutPools(combatant, econ = null) {
  const out = new Set();
  const rules = matchedEffectRules(combatant?.actor, EFFECT_EXCLUSIVE_POOLS);
  if (!rules.length) return out;
  const used = (econ ?? getEconomy(combatant)).used ?? {};
  for (const rule of rules) {
    for (const pool of rule.pools) {
      if (rule.pools.some(other => other !== pool && (used[other] ?? 0) > 0)) out.add(pool);
    }
  }
  return out;
}

/**
 * Whether `type` is barred because a pool it shares a budget with has already been
 * spent (Slow: an action or a Bonus Action, not both).
 */
export function coupledOut(combatant, type) {
  return coupledOutPools(combatant).has(type);
}

/**
 * How many "attack"-type activity uses share a single action this turn (Extra
 * Attack). Order: what was configured for this actor (config.mjs, set by the owner
 * or the GM in the HUD's gear dialog) > the name lookup in guessAttacksPerAction
 * (see actions.mjs) > default of 1 (no Extra Attack).
 *
 * Only ever asked about a TRACKED creature, which is what let the NPC half of the
 * detection go: it parsed "makes three attacks" out of statblock prose purely so a
 * freshly dropped pack of monsters counted correctly without being configured
 * first, and monsters are no longer counted at all. What is left is the fixed
 * English name lookup for the PC class feature, which is the case that cannot be
 * parsed and therefore the case a fallback is actually worth having.
 */
export function getAttacksPerAction(combatant) {
  const actor = combatant?.actor;
  const n = Number(getActorConfig(actor).attacksPerAction);
  if (Number.isFinite(n) && n > 0) return n;
  return guessAttacksPerAction(actor)?.count ?? DEFAULT_ATTACKS_PER_ACTION;
}

export function freshEconomy(combatant) {
  const used = {};
  const granted = {};
  for (const key of Object.keys(RESOURCES)) { used[key] = 0; granted[key] = 0; }
  return {
    key: turnKey(combatant?.combat),
    // WHICH ROUND THIS ECONOMY WAS REFILLED FOR, and the one field `key` cannot be.
    // `key` is written by every spend with the CURRENT turn, so it means "last
    // touched" - during somebody else's turn it moves without this creature's own
    // turn having come round. Only freshEconomy sets this one, so it stays put
    // through a whole round of reactions and is the only honest answer to "has this
    // creature's turn been refilled yet". See isStale below.
    resetRound: combatant?.combat?.round ?? 0,
    used,
    // What a feature handed out this turn (Action Surge: one more action). Kept
    // apart from `max` because max is recomputed from settings on every read, and
    // folding it in there would either be lost or, once written back, counted twice.
    // A FULL map with zeros, never a sparse one: write() goes through setFlag, which
    // merges recursively, so a key dropped between two writes keeps its old value.
    granted,
    max: getMaxima(combatant),
    attacksLeft: 0,    // remaining free "attack"-type uses within the current action
    log: []            // audit trail, newest last -> enables undo
  };
}

/**
 * Has this combatant's turn in the CURRENT round already started?
 *
 * The whole staleness question hangs off this. A creature's pools refill at the start
 * of ITS turn, so before that moment an economy from the previous round is not stale
 * at all - it is exactly right, and a reaction spent out of it must stay spent.
 * Afterwards it is provably overdue.
 */
function turnHasBegun(combatant) {
  const combat = combatant?.combat;
  if (!combat?.started) return false;
  const index = combat.turns?.findIndex?.(t => t.id === combatant.id) ?? -1;
  if (index < 0) return false;
  return index <= (combat.turn ?? 0);
}

/**
 * Did this creature's turn come round without its economy being refilled?
 *
 * THE FAILURE THIS CATCHES: resetTurn only ever runs on the active GM's client, off
 * combatTurnChange. Miss that hook - a reconnect, a throttled background tab - and no
 * reset happens, so a player sits there with pools that stay spent and a bar that
 * refuses a legitimate action while looking entirely certain about it. That is the
 * worst way this module can fail, because nothing about it invites doubt.
 *
 * Deliberately compared on the ROUND and not on `key`'s round:turn. The turn INDEX
 * shifts under a combatant being removed mid-round, which happens every time a GM
 * clears a dead monster off the tracker - and a false positive here does not show a
 * stale bar, it hands back an action that was already spent.
 *
 * A flag written before this field existed reports nothing, and nothing is what it
 * gets: guessing it stale would wipe a live economy on upgrade, mid-encounter.
 */
function isStale(combatant, stored, round) {
  if (!Number.isFinite(stored?.resetRound)) return false;
  if (stored.resetRound === round) return false;
  return turnHasBegun(combatant);
}

export function getEconomy(combatant) {
  const stored = combatant?.getFlag?.(MODULE_ID, FLAGS.ECONOMY);
  const fresh = freshEconomy(combatant);
  if (!stored) return fresh;
  // A reset that never happened. Answered on the READ rather than by writing here:
  // this runs on every client and a repair from a read path would be a second write
  // site for the flag (load-bearing decision 1). It needs none - the next spend
  // starts from what this returns and persists the corrected round with it.
  if (isStale(combatant, stored, fresh.resetRound)) return fresh;
  // Always recompute maxima (level ups, effects, settings changes) but keep `used`.
  // The FRESH maxima win outright. Letting the stored ones override was the same
  // line, and it meant the opposite: max was frozen at whatever it happened to be
  // when the flag was last written, so a Haste landing mid-turn - or a level-up, or
  // a changed world setting - did not show until the next turn reset. Nothing ever
  // writes a max that getMaxima() cannot recompute, so there is nothing to preserve.
  //
  // Spelled out field by field rather than through foundry.utils.mergeObject, which
  // deep-clones both sides on every call. The shape is fixed and two levels deep, so
  // the recursion bought nothing: `used` and `granted` are the only nested maps, and
  // both are full ones seeded by freshEconomy with a stored partial laid over them -
  // which is precisely what the merge did.
  return {
    key: stored.key ?? fresh.key,
    resetRound: stored.resetRound ?? fresh.resetRound,
    used: { ...fresh.used, ...stored.used },
    granted: { ...fresh.granted, ...stored.granted },
    max: fresh.max,
    attacksLeft: stored.attacksLeft ?? fresh.attacksLeft,
    log: stored.log ?? fresh.log
  };
}

/**
 * A pool's size this turn: what the actor normally has, plus whatever a feature
 * granted. Read this rather than econ.max wherever a total is shown or compared -
 * econ.max is the baseline and does not know about Action Surge.
 */
export function poolMax(econ, type) {
  return (econ?.max?.[type] ?? 0) + (econ?.granted?.[type] ?? 0);
}

/**
 * What is left in a pool, from an economy already in hand. The HUD resolves the
 * economy once per render and then asks this about every pool and every attack
 * entry; going back through remaining() for each of those re-read the Combatant flag
 * and recomputed the maxima every time.
 */
export function remainingOf(econ, type) {
  return poolMax(econ, type) - (econ?.used?.[type] ?? 0);
}

export function remaining(combatant, type) {
  return remainingOf(getEconomy(combatant), type);
}

export function canAfford(combatant, type, amount = 1) {
  if (!combatant) return true;
  if (type === "other" || type === null) return true;
  if (blockedPools(combatant).has(type)) return false;
  if (coupledOut(combatant, type)) return false;
  return remaining(combatant, type) >= amount;
}

/** Gate for "attack"-type activities: a queued Extra Attack is always affordable. */
export function canAttack(combatant) {
  if (!combatant) return true;
  // Before the queued-attack shortcut below: a Stunned creature does not get to
  // finish the attack sequence it had started.
  if (blockedPools(combatant).has("action")) return false;
  if ((getEconomy(combatant).attacksLeft ?? 0) > 0) return true;
  return canAfford(combatant, "action");
}

/**
 * Enforcement decision for activity usage (module.mjs's dnd5e.preUseActivity).
 * Returns "allow" | "warn" | "block".
 */
export function checkGate(combatant, type, { isAttack = false } = {}) {
  const mode = game.settings.get(MODULE_ID, "enforceActions");
  if (mode === "off") return "allow";
  if (!game.combat?.started) return "allow";
  if (game.user.isGM && game.settings.get(MODULE_ID, "gmBypass")) return "allow";
  if (!type || type === "other") return "allow";
  if (!combatant) return "allow";
  // Nothing is counted for this creature, so there is no empty pool to refuse on.
  // Checked here rather than in the hook so every caller of the gate agrees.
  if (!isTracked(combatant.actor)) return "allow";

  const affordable = isAttack ? canAttack(combatant) : canAfford(combatant, type);
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
export async function spendAttack(combatant, { label = "", uuid = null, attacks = null } = {}) {
  if (!combatant) return false;
  if (!combatant.isOwner || !canWriteFlags(combatant)) {
    return requestFromGM("spendAttack", { combatantUuid: combatant.uuid, label, uuid, attacks });
  }
  const econ = getEconomy(combatant);
  const attacksLeftBefore = econ.attacksLeft ?? 0;
  let amount;

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
    // First thing to check when "nothing is being counted": a GM-only creature is
    // a launcher, not an economy, and every reading below it will be empty by design.
    tracked: isTracked(subject),
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
    // Which pools share a budget, and which of them that has actually closed yet -
    // a coupling looks like nothing at all until one of the pair is spent.
    coupledPools: probe ? [...coupledPools(probe)] : [],
    coupledOutNow: combatant ? [...coupledOutPools(combatant)] : [],
    // A refill that was missed and is being covered for on the fly. `resetRound`
    // behind the current round while the creature's turn has already come is the
    // whole of the reading (see isStale).
    resetRound: econ?.resetRound ?? null,
    turnHasBegun: combatant ? turnHasBegun(combatant) : false,
    used: econ?.used ?? null,
    grantedThisTurn: econ?.granted ?? null,
    attacksLeft: econ?.attacksLeft ?? null
  };
}

/**
 * Players own their Actor but usually not the Combatant document, so a direct
 * setFlag would throw. Cheap capability probe instead of guessing.
 */
export function canWriteFlags(combatant) {
  return game.user.isGM || combatant?.testUserPermission?.(game.user, "OWNER") === true;
}
