import { MODULE_ID } from "./const.mjs";
import { registerSettings } from "./settings.mjs";
import { registerSocket } from "./socket.mjs";
import { getHUD, refreshHUD } from "./hud.mjs";
import { spend, spendAttack, refund, resetTurn, checkGate, getEconomy } from "./economy.mjs";
import { costOfActivity, isAttackSubstitute } from "./actions.mjs";

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
    hud: getHUD(), spend, refund, resetTurn, getEconomy
  };
  if (game.combat?.started) getHUD().render({ force: true });
});

/* ------------------------------------------------------------------ */
/*  Economy bookkeeping                                                */
/* ------------------------------------------------------------------ */

function combatantFor(actor) {
  if (!actor || !game.combat) return null;
  // actor.id alone collides for unlinked tokens sharing one prototype (e.g. five
  // identical goblins) — match on the token first.
  const tokenId = actor.token?.id ?? actor.getActiveTokens?.(false, true)?.[0]?.id;
  return game.combat.combatants.find(c => c.tokenId === tokenId)
      ?? game.combat.combatants.find(c => c.actor?.uuid === actor.uuid)
      ?? null;
}

/**
 * Gate: block/warn when the pool is empty. Returning false cancels the usage.
 * Runs on the client that initiated the activity, so the check is local and cheap.
 */
Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {
  const type = costOfActivity(activity);
  const combatant = combatantFor(activity.actor);
  // Extra Attack: a queued free attack is always affordable, even once the action
  // pip itself reads as spent. Attack substitutes (Dragonborn Breath Weapon) may
  // stand in for one of those attacks, so they pass the same gate.
  const isAttack = type === "action" && (activity.type === "attack" || isAttackSubstitute(activity));
  const result = checkGate(combatant, type, { isAttack });
  if (result === "allow") return true;

  const msg = game.i18n.format(`${MODULE_ID}.notify.exhausted`, {
    pool: game.i18n.localize(`${MODULE_ID}.pool.${type}`)
  });
  if (result === "block") { ui.notifications.warn(msg); return false; }
  ui.notifications.info(msg);
  return true;
});

/**
 * Book the cost AFTER a successful usage. This is the single write path — it also
 * catches usages triggered from the character sheet, macros and Midi QoL workflows.
 */
Hooks.on("dnd5e.postUseActivity", async (activity, usageConfig, results) => {
  if (!game.combat?.started) return;
  const type = costOfActivity(activity);
  if (!type || type === "other") return;
  const combatant = combatantFor(activity.actor);
  if (!combatant) return;

  const label = activity.name || activity.item?.name || "";
  // Extra Attack: dnd5e fires postUseActivity once per Attack-activity click, with
  // no built-in "number of attacks" step (verified live: a level 5 Fighter's second
  // Attack click is its own postUseActivity, not bundled with the first). Route
  // "attack"-type activities through the counter so repeat clicks within one action
  // don't each burn a fresh action pip. NPC Multiattack (descriptive-only utility)
  // never reaches here - costOfActivity() returns null for it (see actions.mjs).
  // Attack substitutes book through the same counter: opening the turn with a
  // Breath Weapon still means "took the Attack action, replaced one attack", so
  // spendAttack()'s first-use branch (spend the action, queue the rest) is exactly
  // the RAW behaviour.
  if (type === "action" && (activity.type === "attack" || isAttackSubstitute(activity))) {
    await spendAttack(combatant, { label, uuid: activity.uuid });
    return;
  }

  await spend(combatant, type, { label, uuid: activity.uuid });
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
/*  Keep the action list current                                       */
/* ------------------------------------------------------------------ */

Hooks.on("updateActor", refreshHUD);
Hooks.on("createItem", refreshHUD);
Hooks.on("updateItem", refreshHUD);
Hooks.on("deleteItem", refreshHUD);
Hooks.on("createActiveEffect", refreshHUD);
Hooks.on("deleteActiveEffect", refreshHUD);
