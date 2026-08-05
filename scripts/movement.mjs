import { MODULE_ID } from "./const.mjs";
import { getEconomy } from "./economy.mjs";

/**
 * Foundry v13 records token movement itself, including terrain cost, and clears the
 * histories on turn start (Combat#_clearMovementHistoryOnStartTurn). So we DERIVE the
 * remaining movement instead of storing a counter — no drift, no double bookkeeping.
 *
 * VERIFY IN CONSOLE once: `_token.document.movementHistory` and `_token.document.movement`.
 * The shape is { recorded, unrecorded, distance, cost, spaces, diagonals }.
 */

function readHistory(tokenDoc) {
  return tokenDoc?.movementHistory ?? tokenDoc?.movement?.history ?? null;
}

export function getMovement(combatant) {
  const tokenDoc = combatant?.token ?? null;
  const actor = combatant?.actor ?? null;
  const speeds = actor?.system?.attributes?.movement ?? {};
  const units = speeds.units || canvas?.scene?.grid?.units || "ft";

  const preferred = combatant?.getFlag?.(MODULE_ID, "movementMode") || "walk";
  const mode = Number(speeds[preferred]) > 0 ? preferred : "walk";
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
      .filter(([k, v]) => Number(v) > 0 && !["units", "hover"].includes(k))
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
