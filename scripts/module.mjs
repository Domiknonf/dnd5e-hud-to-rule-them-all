import { MODULE_ID } from "./const.mjs";
import { registerSettings } from "./settings.mjs";
import { registerSocket } from "./socket.mjs";
import { getHUD, refreshHUD } from "./hud.mjs";
import {
  spend, spendAttack, refund, resetTurn, checkGate, getEconomy, combatantFor, poolForNow, grant
} from "./economy.mjs";
import {
  costOfActivity, countsAsAttack, attacksForActivity, entryKeyForActivity, grantsForActivity,
  useLabel
} from "./actions.mjs";
import { openConfig } from "./config-app.mjs";
import { openMultiattack } from "./multiattack-app.mjs";
import { getActorConfig } from "./config.mjs";

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  registerSettings();
  registerSocket();
  const { loadTemplates } = foundry.applications.handlebars;
  loadTemplates([
    `modules/${MODULE_ID}/templates/hud.hbs`,
    `modules/${MODULE_ID}/templates/config.hbs`,
    `modules/${MODULE_ID}/templates/multiattack.hbs`
  ]);
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = {
    hud: getHUD(), spend, refund, resetTurn, getEconomy,
    // Macro entry point: openConfig(actor) for a hotkey or a token-HUD button.
    // openMultiattack(actor) is the way in for a creature whose sheet has no
    // Multiattack feature, since the dialog only offers the row to creatures that do.
    openConfig, openMultiattack, getActorConfig
  };
  // Starts collapsed outside combat: the bar is available, but it does not shove
  // the macro bar aside until someone actually pulls it up (or combat starts).
  if (!game.combat?.started) getHUD().collapse(true);
  refreshHUD();
});

/* ------------------------------------------------------------------ */
/*  Economy bookkeeping                                                */
/* ------------------------------------------------------------------ */

/**
 * Gate: block/warn when the pool is empty. Returning false cancels the usage.
 * Runs on the client that initiated the activity, so the check is local and cheap.
 */
Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {
  const combatant = combatantFor(activity.actor);
  // Resolved once, before anything else, so the gate, the warning text and the
  // booking below all talk about the same pool. Off-turn this turns an action into
  // the reaction it actually is (see economy.poolForNow).
  const type = poolForNow(combatant, costOfActivity(activity));
  // Extra Attack: a queued free attack is always affordable, even once the action
  // pip itself reads as spent. Attack substitutes (Dragonborn Breath Weapon) may
  // stand in for one of those attacks, so they pass the same gate.
  const isAttack = type === "action" && countsAsAttack(activity);
  const result = checkGate(combatant, type, { isAttack, key: isAttack ? entryKeyForActivity(activity) : null });
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
  const combatant = combatantFor(activity.actor);
  if (!combatant) return;
  // Same resolution the gate above made, so what was checked is what gets booked.
  const type = poolForNow(combatant, costOfActivity(activity));
  const label = useLabel(activity);
  // What this use HANDS OUT (Action Surge). Resolved before the early return below,
  // because a feature that grants an action may well cost nothing itself - and then
  // there is no spend for it to ride along on.
  const grants = grantsForActivity(activity);

  if (!type || type === "other") {
    if (grants) await grant(combatant, grants, { label, uuid: activity.uuid });
    return;
  }
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
  // An off-turn attack never gets here: poolForNow() has already made it a reaction,
  // so an Opportunity Attack spends the reaction pip instead of opening an Attack
  // action and queueing Extra Attacks against somebody else's turn.
  if (type === "action" && countsAsAttack(activity)) {
    await spendAttack(combatant, {
      label, uuid: activity.uuid,
      attacks: attacksForActivity(activity),
      key: entryKeyForActivity(activity)
    });
    // Rare enough to be worth a second write rather than a fifth parameter on
    // spendAttack: an attack that also grants something is a configured oddity.
    if (grants) await grant(combatant, grants, { label, uuid: activity.uuid });
    return;
  }

  await spend(combatant, type, { label, uuid: activity.uuid, grants });
});

/* ------------------------------------------------------------------ */
/*  Turn / round handling                                              */
/* ------------------------------------------------------------------ */

Hooks.on("combatStart", async (combat) => {
  if (game.user.isActiveGM) for (const c of combat.combatants) await resetTurn(c);
  // Symmetric to deleteCombat below: an encounter starting pulls the bar back up
  // even if it was manually slid away out of combat.
  getHUD().collapse(false);
  refreshHUD();
});

// v13 fires this with the previous and the new turn pointer.
Hooks.on("combatTurnChange", async (combat, prior, current) => {
  const combatant = combat.combatants.get(current?.combatantId);
  if (game.user.isActiveGM && combatant) await resetTurn(combatant);
  refreshHUD();
});

Hooks.on("updateCombat", refreshHUD);
// The bar survives the encounter as a plain ability hotbar. Ending combat slides it
// away rather than destroying it, so it can be pulled back up from the corner tab.
Hooks.on("deleteCombat", () => { getHUD().collapse(true); refreshHUD(); });
Hooks.on("updateCombatant", refreshHUD);
Hooks.on("createCombatant", refreshHUD);
Hooks.on("deleteCombatant", refreshHUD);

/* ------------------------------------------------------------------ */
/*  Keep the action list current                                       */
/* ------------------------------------------------------------------ */

// Outside combat the bar follows the selected token / assigned character, so both
// of those have to re-render it (see CombatHUD#subjectActor).
Hooks.on("controlToken", refreshHUD);
Hooks.on("updateUser", refreshHUD);

Hooks.on("updateActor", refreshHUD);
Hooks.on("createItem", refreshHUD);
Hooks.on("updateItem", refreshHUD);
Hooks.on("deleteItem", refreshHUD);
Hooks.on("createActiveEffect", refreshHUD);
Hooks.on("deleteActiveEffect", refreshHUD);
