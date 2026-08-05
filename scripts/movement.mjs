import { MODULE_ID, MOVEMENT_TYPES } from "./const.mjs";
import { getEconomy } from "./economy.mjs";

/**
 * Foundry v13 records token movement itself, including terrain cost, and clears the
 * histories on turn start (Combat#_clearMovementHistoryOnStartTurn). So we DERIVE the
 * remaining movement instead of storing a counter — no drift, no double bookkeeping.
 */

/**
 * VERIFIED live (Foundry 13.351 / dnd5e 5.3.3), across a turn boundary specifically:
 * tokenDoc.movementHistory (flat array of waypoints) IS reliably cleared to [] at
 * turn start, matching Combat#_clearMovementHistoryOnStartTurn. tokenDoc.movement
 * (singular) is just the data of the last movement OPERATION - it is NOT cleared at
 * turn start and keeps last turn's cost until a new move overwrites it. Trusting it
 * first (as this used to) reads a stale "budget already spent" value right after
 * End Turn, which combined with enforceMovement's hard stop can softlock a token
 * that ended last turn at 0 left - the very first move needed to refresh the cache
 * gets blocked by the stale cache. So: sum the flat array, and only fall back to
 * the cached movement.history if the array itself isn't present at all.
 */
function readHistory(tokenDoc) {
  const flat = tokenDoc?.movementHistory;
  if (Array.isArray(flat)) return { cost: flat.reduce((sum, wp) => sum + Number(wp?.cost ?? 0), 0) };
  return tokenDoc?.movement?.history ?? null;
}

export function getMovement(combatant) {
  const tokenDoc = combatant?.token ?? null;
  const actor = combatant?.actor ?? null;
  const speeds = actor?.system?.attributes?.movement ?? {};
  const units = speeds.units || canvas?.scene?.grid?.units || "ft";

  const preferred = combatant?.getFlag?.(MODULE_ID, "movementMode") || "walk";
  // A stale flag from before MOVEMENT_TYPES existed (e.g. "max", cycled into
  // accidentally) must not resolve as a real mode - fall back to walk.
  const mode = MOVEMENT_TYPES.includes(preferred) && Number(speeds[preferred]) > 0 ? preferred : "walk";
  const base = Number(speeds[mode] ?? 0);

  const econ = getEconomy(combatant);
  const budget = base * (1 + (econ.dash ?? 0));

  const history = readHistory(tokenDoc);
  const used = Number(history?.cost ?? history?.distance ?? 0);

  return {
    mode,
    base,
    budget,
    used: Math.round(used * 100) / 100,
    left: Math.round(Math.max(0, budget - used) * 100) / 100,
    over: used > budget,
    pct: budget > 0 ? Math.min(100, (used / budget) * 100) : 0,
    units,
    modes: Object.entries(speeds)
      .filter(([k, v]) => MOVEMENT_TYPES.includes(k) && Number(v) > 0)
      .map(([k, v]) => ({ key: k, value: v, active: k === mode }))
  };
}

/** Optional hard stop: block movement that would exceed the budget. */
export function enforceMovement(tokenDoc, movement) {
  if (!game.settings.get(MODULE_ID, "enforceMovement")) return true;
  const combatant = game.combat?.combatants?.find(c => c.tokenId === tokenDoc.id);
  if (!combatant || game.combat?.combatant?.id !== combatant.id) return true;
  if (game.user.isGM && game.settings.get(MODULE_ID, "gmBypass")) return true;

  const { left } = getMovement(combatant);
  const planned = Number(movement?.passed?.cost ?? movement?.pending?.cost ?? 0);
  if (planned > left + 0.01) {
    ui.notifications.warn(game.i18n.format(`${MODULE_ID}.notify.noMovement`, { left }));
    return false;
  }
  return true;
}
