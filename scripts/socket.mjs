import { SOCKET } from "./const.mjs";

/**
 * Minimal request/relay layer. socketlib is in the stack and is nicer, but a raw
 * socket keeps the dependency list at zero for v0.x. Swap later if you want ACKs.
 */

let handlers = null;

export function registerSocket() {
  game.socket.on(SOCKET, async ({ action, data } = {}) => {
    if (!game.user.isActiveGM) return;          // exactly one GM executes
    if (!handlers) handlers = await import("./economy.mjs");
    const combatant = await fromUuid(data?.combatantUuid);
    if (!combatant) return;
    switch (action) {
      case "spend":           return handlers.spend(combatant, data.type, data);
      case "spendAttack":     return handlers.spendAttack(combatant, data);
      case "refund":          return handlers.refund(combatant, data.type, data.amount ?? 1);
      case "dash":            return handlers.dash(combatant);
      case "grantDashBonus":  return handlers.grantDashBonus(combatant);
      case "resetTurn":       return handlers.resetTurn(combatant);
    }
  });
}

export function requestFromGM(action, data) {
  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("dnd5e-hud-to-rule-them-all.notify.noGM"));
    return false;
  }
  game.socket.emit(SOCKET, { action, data });
  return true;
}
