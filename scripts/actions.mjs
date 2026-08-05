import {
  MODULE_ID, RESOURCES, ACTIVATION_MAP, OUT_OF_COMBAT_ACTIVATIONS, INTRINSIC_ACTIONS,
  GENERIC_ACTIVITY_ICON
} from "./const.mjs";

/**
 * In dnd5e 4.x+ the unit of "a thing you do" is an Activity, not an Item.
 * One item can carry several activities with different activation types
 * (e.g. Net: Attack = action, a Utility = bonus). Always iterate activities.
 */

export function bucketFor(activationType) {
  if (!activationType) return null;
  if (OUT_OF_COMBAT_ACTIVATIONS.has(activationType)) return null;
  return ACTIVATION_MAP[activationType] ?? "other";
}

/**
 * NPC Multiattack (and similar "this feature just describes several attacks")
 * features are utility-type activities with no roll, no consumption and no effects
 * - mechanically inert, just a chat description. Verified against Multiattack
 * (nothing) vs. Second Wind (type "heal", real consumption+healing) live. Filtering
 * on activity.type alone would also hide real utility actions like Second Wind, so
 * check for the absence of any actual mechanical effect instead of the type/name.
 */
export function isDescriptiveOnly(activity) {
  if (activity?.type !== "utility") return false;
  // Spells always do something real even when it isn't encoded as roll/consumption/
  // effects data (Misty Step's teleport, Prestidigitation's chosen minor effect are
  // both manual/narrative) - verified live these silently stopped booking their cost
  // once this filter existed. Only apply to features (Multiattack and its kin).
  if (activity.item?.type === "spell") return false;
  const hasRoll = !!activity.roll?.formula;
  const hasConsumption = (activity.consumption?.targets?.length ?? 0) > 0;
  const hasEffects = (activity.effects?.length ?? 0) > 0;
  return !hasRoll && !hasConsumption && !hasEffects;
}

const ATTACK_COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };

/**
 * Best-effort read of "how many attacks does Multiattack grant" straight out of the
 * feature's own description text (SRD phrasing: "makes three attacks", "makes two
 * Arcane Burst attacks", ...). This is a guess, not a parse of structured data - it
 * will misread anything that isn't "N (of the same) attacks" (e.g. "one bite and one
 * claw attack"). That is why config.attacksPerAction (see economy.getAttacksPerAction)
 * always wins when the GM has set it by hand. Matched against a descriptive-only
 * utility activity (see isDescriptiveOnly) so it isn't tied to the item being named
 * "Multiattack" specifically.
 */
export function guessAttacksPerAction(actor) {
  if (!actor) return null;
  for (const item of actor.items ?? []) {
    const activities = item.system?.activities;
    if (!activities?.size) continue;
    if (!Array.from(activities).some(isDescriptiveOnly)) continue;

    // Strip HTML tags AND Foundry's [[...]]{type} content-link/enricher syntax before
    // matching - dnd5e statblocks link the attack name via [[/item .someId]], which
    // is long enough to blow past a naive word-gap window (verified: broke the
    // Archmage's "makes four [[/item .mmArcaneBurst000]] attacks" but not the
    // shorter-by-coincidence text that happened to work before).
    const text = (item.system?.description?.value ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\[\[[^\]]*\]\](\{[^}]*\})?/g, " ")
      .toLowerCase();
    const match = text.match(/\b(one|two|three|four|five|six|seven|eight|\d+)\b[^.]{0,25}?\battacks?\b/);
    if (!match) continue;
    const count = ATTACK_COUNT_WORDS[match[1]] ?? Number(match[1]);
    if (Number.isInteger(count) && count > 1) return count;
  }
  return null;
}

/** Cheap availability filter. Extend this — it is where most house rules land. */
function isUsable(item) {
  // dnd5e caches a real spell Item on the actor for every "cast" activity on a
  // feature (NPC Spellcasting, Innate Spellcasting). Both would surface, so the
  // cached copy is dropped and the activity on the parent feature wins.
  if (item.getFlag?.("dnd5e", "cachedFor")) return false;

  if (item.system?.equipped === false && game.settings.get(MODULE_ID, "hideUnequipped")) return false;

  if (item.type === "spell" && game.settings.get(MODULE_ID, "hideUnprepared")) {
    const sys = item.system ?? {};
    // NPC statblocks list what the creature can cast; preparation does not apply.
    if (item.actor?.type === "character") {
      const method = sys.method ?? sys.preparation?.mode;
      // dnd5e 5.1+: system.prepared is numeric (0 unprepared, 1 prepared, 2 always).
      // Older schema used a boolean on preparation.prepared.
      const raw = sys.prepared ?? sys.preparation?.prepared;
      const prepared = raw === true || Number(raw) > 0;
      if (method === "spell" && (sys.level ?? 0) > 0 && !prepared) return false;
    }
  }

  return true;
}

function usesFor(activity, item) {
  const a = activity.uses ?? {};
  const i = item.system?.uses ?? {};
  const value = a.max ? a.value : i.max ? i.value : null;
  const max = a.max ? a.max : i.max ? i.max : null;
  if (max === null) return null;
  return { value, max };
}

export function collectActions(actor, combatant) {
  const buckets = {};
  for (const key of Object.keys(RESOURCES)) buckets[key] = [];
  if (!actor) return buckets;

  for (const item of actor.items) {
    const activities = item.system?.activities;
    if (!activities?.size) continue;
    if (!isUsable(item)) continue;

    // dnd5e fills activity.name with the activity's type label ("Cast", "Save",
    // "Attack") when nobody gave it an explicit name, so `activity.name || item.name`
    // never falls back. Only reach for the activity name when the item carries
    // several activities and the item name alone would be ambiguous.
    const multi = activities.size > 1;

    for (const activity of activities) {
      const bucket = bucketFor(activity.activation?.type);
      if (!bucket) continue;
      if (isDescriptiveOnly(activity)) continue;
      const name = multi ? (activity.name || item.name) : item.name;
      const activityImg = activity.img && !GENERIC_ACTIVITY_ICON.test(activity.img) ? activity.img : null;
      buckets[bucket].push({
        kind: "activity",
        uuid: activity.uuid,
        name,
        subtitle: multi ? item.name : "",
        img: activityImg || item.img,
        activityType: activity.type,
        itemType: item.type,
        level: item.type === "spell" ? item.system.level : null,
        uses: usesFor(activity, item)
      });
    }
  }

  if (game.settings.get(MODULE_ID, "showIntrinsic")) {
    for (const def of INTRINSIC_ACTIONS) {
      buckets[def.type]?.push({
        kind: "intrinsic",
        id: def.id,
        handler: def.handler,
        skill: def.skill ?? null,
        name: game.i18n.localize(`${MODULE_ID}.intrinsic.${def.id}`),
        subtitle: "",
        icon: def.icon
      });
    }
  }

  const sort = game.settings.get(MODULE_ID, "sortAlphabetically");
  if (sort) for (const key of Object.keys(buckets)) buckets[key].sort((a, b) => a.name.localeCompare(b.name));
  return buckets;
}

/** Used by the economy watcher to know what a used activity costs. */
export function costOfActivity(activity) {
  if (isDescriptiveOnly(activity)) return null;
  return bucketFor(activity?.activation?.type);
}
