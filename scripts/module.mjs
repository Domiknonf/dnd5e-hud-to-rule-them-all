import { MODULE_ID } from "./const.mjs";
import { registerSettings } from "./settings.mjs";
import { registerSocket } from "./socket.mjs";
import { getHUD, refreshHUD, refreshHUDFor } from "./hud.mjs";
import {
  spend, spendAttack, refund, resetTurn, checkGate, getEconomy, combatantFor, poolForNow, grant,
  diagnose, isTracked
} from "./economy.mjs";
import {
  costOfActivity, countsAsAttack, attacksForActivity, grantsForActivity, useLabel
} from "./actions.mjs";
import { openConfig } from "./config-app.mjs";
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
    `modules/${MODULE_ID}/templates/config.hbs`
  ]);
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = {
    hud: getHUD(), spend, refund, resetTurn, getEconomy,
    // Macro entry point: openConfig(actor) for a hotkey or a token-HUD button.
    openConfig, getActorConfig,
    // Console entry point: api.diagnose() prints what the module believes about the
    // selected token, so "nothing happens" has an answer that is not a guess.
    diagnose
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
  // A GM-run creature is not counted at all (see economy.isTracked), so there is
  // nothing to book. Checked before the combatant lookup because this is also what
  // keeps a monster-heavy encounter from writing a Combatant flag - and re-rendering
  // every client's bar - on every single attack the GM rolls.
  if (!isTracked(activity.actor)) return;
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
      attacks: attacksForActivity(activity)
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
  // Only the tracked ones carry an economy to refill. On a twelve-goblin encounter
  // this is the difference between one flag write per player and thirteen.
  if (game.user.isActiveGM) {
    // In parallel: these are independent Combatant documents, and awaiting them one
    // by one made the start of an encounter a chain of round trips as long as the
    // party. Order does not matter - each write only touches its own combatant.
    await Promise.all(combat.combatants
      .filter(c => isTracked(c.actor))
      .map(c => resetTurn(c)));
  }
  // Symmetric to deleteCombat below: an encounter starting pulls the bar back up
  // even if it was manually slid away out of combat.
  getHUD().collapse(false);
  refreshHUD();
});

// v13 fires this with the previous and the new turn pointer.
Hooks.on("combatTurnChange", async (combat, prior, current) => {
  const combatant = combat.combatants.get(current?.combatantId);
  if (game.user.isActiveGM && combatant && isTracked(combatant.actor)) await resetTurn(combatant);
  refreshHUD();
});

Hooks.on("updateCombat", refreshHUD);
// The bar survives the encounter as a plain ability hotbar. Ending combat slides it
// away rather than destroying it, so it can be pulled back up from the corner tab.
Hooks.on("deleteCombat", () => { getHUD().collapse(true); refreshHUD(); });
// The economy flag lives here, so this fires on every booked action in the party and
// lands on every client, while a bar only ever shows one of those creatures. A change
// to WHICH creature a combatant stands for is never filtered - it can move the subject.
Hooks.on("updateCombatant", (doc, changed) => {
  if (changed.actorId !== undefined || changed.tokenId !== undefined) return refreshHUD();
  refreshHUDFor(doc.actor);
});
// Who is in the fight decides who a player without a selected token falls back to,
// so these two always redraw.
Hooks.on("createCombatant", refreshHUD);
Hooks.on("deleteCombatant", refreshHUD);

/* ------------------------------------------------------------------ */
/*  Keep the action list current                                       */
/* ------------------------------------------------------------------ */

// Outside combat the bar follows the selected token / assigned character, so both
// of those have to re-render it (see CombatHUD#subjectActor).
Hooks.on("controlToken", refreshHUD);
Hooks.on("updateUser", refreshHUD);

/** An effect hangs off the actor directly, or off one of its items. */
const effectActor = (effect) =>
  (effect?.parent?.documentName === "Actor" ? effect.parent : effect?.parent?.actor) ?? null;

// Everything below fires for every creature in the world, while the bar shows exactly
// one - so these route through refreshHUDFor, which drops the updates that cannot
// reach it. Anything that decides WHO is shown (above) redraws unconditionally.
Hooks.on("updateActor", (doc, changed) => refreshHUDFor(doc, changed));
Hooks.on("createItem", (doc) => refreshHUDFor(doc.actor));
Hooks.on("updateItem", (doc) => refreshHUDFor(doc.actor));
Hooks.on("deleteItem", (doc) => refreshHUDFor(doc.actor));
Hooks.on("createActiveEffect", (doc) => refreshHUDFor(effectActor(doc)));
Hooks.on("deleteActiveEffect", (doc) => refreshHUDFor(effectActor(doc)));
// Enabling or disabling an existing effect fires UPDATE, not create - and that is how
// DAE commonly applies one. Without this, Haste landing on a creature that already
// carried the (disabled) effect changed the economy and never redrew the bar.
Hooks.on("updateActiveEffect", (doc) => refreshHUDFor(effectActor(doc)));
// A condition applied through the token HUD's status icons rather than as an effect.
Hooks.on("updateToken", (doc, changed) => {
  // A token that changed which actor it stands for may well have been showing the
  // previous one, and `doc.actor` now answers for the new one - so do not filter.
  if (changed.actorId !== undefined || changed.actorLink !== undefined) return refreshHUD();
  refreshHUDFor(doc.actor, changed);
});
