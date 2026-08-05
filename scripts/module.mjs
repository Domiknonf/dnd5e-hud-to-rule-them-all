import { MODULE_ID } from "./const.mjs";
import { registerSettings } from "./settings.mjs";
import { registerSocket } from "./socket.mjs";
import { getHUD, refreshHUD } from "./hud.mjs";
import { spend, refund, resetTurn, canAfford, getEconomy } from "./economy.mjs";
import { getMovement, enforceMovement } from "./movement.mjs";
import { costOfActivity } from "./actions.mjs";

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  registerSettings();
  registerSocket();
  const { loadTemplates } = foundry.applications.handlebars;
  loadTemplates([`modules/${MODULE_ID}/templates/hud.hbs`]);
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = {
    hud: getHUD(), spend, refund, resetTurn, getEconomy, getMovement
  };
  if (game.combat?.started) getHUD().render({ force: true });
});

/* ------------------------------------------------------------------ */
/*  Economy bookkeeping                                                */
/* ------------------------------------------------------------------ */

function combatantFor(actor) {
  if (!actor || !game.combat) return null;
  return game.combat.combatants.find(c => c.actor?.id === actor.id) ?? null;
}

/**
 * Gate: block/warn when the pool is empty. Returning false cancels the usage.
 * Runs on the client that initiated the activity, so the check is local and cheap.
 */
Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {
  const mode = game.settings.get(MODULE_ID, "enforceActions");
  if (mode === "off") return true;
  if (!game.combat?.started) return true;
  if (game.user.isGM && game.settings.get(MODULE_ID, "gmBypass")) return true;

  const type = costOfActivity(activity);
  if (!type || type === "other") return true;

  const combatant = combatantFor(activity.actor);
  if (!combatant) return true;
  if (canAfford(combatant, type)) return true;

  const msg = game.i18n.format(`${MODULE_ID}.notify.exhausted`, {
    pool: game.i18n.localize(`${MODULE_ID}.pool.${type}`)
  });
  if (mode === "block") { ui.notifications.warn(msg); return false; }
  ui.notifications.info(msg);
  return true;
});

/**
 * Book the cost AFTER a successful usage. This is the single write path — it also
 * catches usages triggered from the character sheet, macros and Midi QoL workflows.
 */
Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, results) => {
  if (!game.combat?.started) return;
  const type = costOfActivity(activity);
  if (!type || type === "other") return;
  const combatant = combatantFor(activity.actor);
  if (!combatant) return;

  // TODO: Extra Attack. One Attack action can contain several attack rolls; if you
  // ever move the booking to the attack roll hooks, guard with a per-turn counter.
  spend(combatant, type, {
    label: activity.name || activity.item?.name || "",
    uuid: activity.uuid
  });
});

/* ------------------------------------------------------------------ */
/*  Turn / round handling                                              */
/* ------------------------------------------------------------------ */

Hooks.on("combatStart", async (combat) => {
  if (game.user.isActiveGM) for (const c of combat.combatants) await resetTurn(c);
  refreshHUD();
});

// v13 fires this with the previous and the new turn pointer.
Hooks.on("combatTurnChange", async (combat, prior, current) => {
  const combatant = combat.combatants.get(current?.combatantId);
  if (game.user.isActiveGM && combatant) await resetTurn(combatant);
  refreshHUD();
});

Hooks.on("updateCombat", refreshHUD);
Hooks.on("deleteCombat", () => getHUD().close());
Hooks.on("updateCombatant", refreshHUD);
Hooks.on("createCombatant", refreshHUD);
Hooks.on("deleteCombatant", refreshHUD);

/* ------------------------------------------------------------------ */
/*  Movement                                                           */
/* ------------------------------------------------------------------ */

Hooks.on("preMoveToken", (tokenDoc, movement) => enforceMovement(tokenDoc, movement));
Hooks.on("moveToken", refreshHUD);
Hooks.on("updateToken", refreshHUD);

/* ------------------------------------------------------------------ */
/*  Keep the action list current                                       */
/* ------------------------------------------------------------------ */

Hooks.on("updateActor", refreshHUD);
Hooks.on("createItem", refreshHUD);
Hooks.on("updateItem", refreshHUD);
Hooks.on("deleteItem", refreshHUD);
Hooks.on("createActiveEffect", refreshHUD);
Hooks.on("deleteActiveEffect", refreshHUD);
