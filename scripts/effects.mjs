import { MODULE_ID } from "./const.mjs";
import { requestFromGM } from "./socket.mjs";

/**
 * Put an activity's effects on the creatures it was aimed at.
 *
 * dnd5e never does this by itself: a cast of Protection from Evil and Good creates
 * the caster's concentration and a chat card whose effect tray has an Apply button,
 * and that button refuses any creature the player does not own. So "the spell did
 * nothing but concentrate" was dnd5e's normal behaviour - this finishes the job
 * once the target picker has said who the spell is for.
 *
 * Only for activities that put an effect on their target unconditionally. A save
 * (Hold Person) or an attack (Ray of Enfeeblement) applies its effect only on a
 * failed save or a hit, which the card resolves later - those keep the manual button.
 */
const UNCONDITIONAL = new Set(["utility", "heal"]);

export function shouldApply(activity) {
  if (!game.settings.get(MODULE_ID, "autoApplyEffects")) return false;
  // Midi QoL applies effects in its own workflow; doing it again would race it.
  if (game.modules.get("midi-qol")?.active) return false;
  return UNCONDITIONAL.has(activity?.type);
}

/**
 * Apply every effect of the usage to every current target. Mirrors dnd5e's own
 * EffectApplicationElement#_applyEffectToActor exactly - same origin, same
 * dependentOn flag - so ending concentration removes the effects again, and a later
 * click on the card's Apply button finds them and only refreshes them instead of
 * stacking a second copy.
 */
export async function applyToTargets(activity, results) {
  if (!results?.message || !shouldApply(activity)) return;
  const effects = (activity.applicableEffects ?? []).filter(e => e.type !== "enchantment");
  if (!effects.length) return;
  const actors = [...new Set([...game.user.targets].map(t => t.actor).filter(Boolean))];
  if (!actors.length) return;

  const caster = activity.actor;
  const concentration = caster?.effects.get(results.message.system?.concentration ?? "") ?? null;
  const flags = {
    scaling: results.message.system?.scaling ?? null,
    spellLevel: results.message.system?.spellLevel ?? null
  };

  let delegated = false;
  for (const actor of actors) {
    for (const effect of effects) {
      const request = {
        effectUuid: effect.uuid, actorUuid: actor.uuid,
        originUuid: (concentration ?? effect).uuid, ...flags
      };
      if (game.user.isGM || actor.isOwner) {
        try {
          await applyEffect(effect, actor, request);
        } catch (err) {
          console.warn(`${MODULE_ID} | could not apply ${effect.name} to ${actor.name}`, err);
        }
      } else {
        // An ally's character, a monster: only a GM may write to it.
        delegated = requestFromGM("applyEffect", request) || delegated;
      }
    }
  }
  if (delegated) ui.notifications.info(game.i18n.format(`${MODULE_ID}.effects.delegated`, {
    name: activity.item?.name ?? activity.name
  }));
}

/** The write itself, on whichever client may make it. */
export async function applyEffect(effect, actor, { originUuid, scaling, spellLevel }) {
  const effectFlags = { flags: { dnd5e: { dependentOn: originUuid, scaling, spellLevel } } };
  const existing = actor.effects.find(e => e.origin === originUuid);
  if (existing) {
    return existing.update(foundry.utils.mergeObject({
      ...effect.constructor.getInitialDuration(),
      disabled: false
    }, effectFlags));
  }
  const data = foundry.utils.mergeObject({
    ...effect.toObject(),
    disabled: false,
    transfer: false,
    origin: originUuid
  }, effectFlags);
  return ActiveEffect.implementation.create(data, { parent: actor });
}

/** Socket side: the active GM applies what a player could not. */
export async function applyEffectRequest(data) {
  const effect = await fromUuid(data?.effectUuid);
  const actor = await fromUuid(data?.actorUuid);
  if (!effect || !actor) return;
  // Only an effect that comes from an item, onto a creature, with an origin that is
  // that effect or a concentration effect - not an arbitrary write on request.
  if (!(effect.parent instanceof Item) || actor.documentName !== "Actor") return;
  const origin = await fromUuid(data.originUuid);
  if (origin !== effect && !origin?.statuses?.has?.("concentrating")) return;
  return applyEffect(effect, actor, data);
}
