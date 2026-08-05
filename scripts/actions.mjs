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
 * - mechanically inert, just a chat description. Verified live, twice over:
 * - Multiattack (nothing) vs. Second Wind (type "heal", real consumption+healing) -
 *   filtering on activity.type alone would also hide real utility actions.
 * - Multiattack vs. Cunning Action's Dash/Disengage sub-activities, which are ALSO
 *   utility with empty roll/consumption/effects (Dash needs no roll to represent
 *   "you may take this as a bonus action") but are very much real. The reliable
 *   difference: item.system.type.value is "monster" for Multiattack and its kin,
 *   "class" (or race/feat/background) for real granted actions like Cunning
 *   Action. Only NPC monster features get to be pure chat-flavor text; spells
 *   don't even have this field, so they were never at risk once this landed.
 */
export function isDescriptiveOnly(activity) {
  if (activity?.type !== "utility") return false;
  if (activity.item?.system?.type?.value !== "monster") return false;
  const hasRoll = !!activity.roll?.formula;
  const hasConsumption = (activity.consumption?.targets?.length ?? 0) > 0;
  const hasEffects = (activity.effects?.length ?? 0) > 0;
  return !hasRoll && !hasConsumption && !hasEffects;
}

const ATTACK_COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };

/**
 * PC "Extra Attack"-style feature names, English SRD content only (this module
 * assumes English compendiums - see README). Deliberately a plain name lookup, not
 * a text parser: the vocabulary is small, fixed and only ever appears on Player
 * Characters (Fighter/Barbarian/Paladin/Ranger all use the same three names as they
 * level up), so parsing freeform description text would be needless complexity for
 * zero extra robustness. Homebrew or translated content needs the manual
 * config.attacksPerAction override instead.
 */
const PC_EXTRA_ATTACK_NAMES = {
  "extra attack": 2,
  "two extra attacks": 3,
  "three extra attacks": 4
};

function stripEnrichers(text) {
  // Strip HTML tags AND Foundry's [[...]]{type} content-link/enricher syntax before
  // matching - dnd5e statblocks link things via [[/item .someId]], which is long
  // enough to blow past a naive word-gap window (verified: broke the Archmage's
  // "makes four [[/item .mmArcaneBurst000]] attacks" but not the shorter-by-
  // coincidence text that happened to work before).
  return (text ?? "").replace(/<[^>]+>/g, " ").replace(/\[\[[^\]]*\]\](\{[^}]*\})?/g, " ").toLowerCase();
}

/**
 * Best-effort read of "how many attacks does this actor get per Attack action".
 * Two independent, deliberately different strategies:
 * - PCs: fixed name lookup (PC_EXTRA_ATTACK_NAMES) - the feature only exists on
 *   Player Characters and always uses one of three known English names.
 * - NPCs: freeform text match on a Multiattack-shaped feature's own description
 *   (SRD phrasing: "makes three attacks"), matched against a descriptive-only
 *   utility activity (see isDescriptiveOnly) so it isn't tied to the item being
 *   named "Multiattack" specifically - monster text has no fixed vocabulary, so
 *   this one genuinely needs to parse content rather than match a name.
 * Both are guesses, not structured data - config.attacksPerAction (see
 * economy.getAttacksPerAction) always wins when the GM has set it by hand.
 */
export function guessAttacksPerAction(actor) {
  if (!actor) return null;
  // Take the highest match, not the first: a Fighter past level 11 may carry both
  // the base "Extra Attack" and an upgrade feature like "Two Extra Attacks" at
  // once, and iteration order isn't guaranteed to put the current tier first.
  let best = null;

  if (actor.type === "character") {
    for (const item of actor.items ?? []) {
      const count = PC_EXTRA_ATTACK_NAMES[item.name?.trim().toLowerCase()];
      if (count) best = Math.max(best ?? 0, count);
    }
  }

  for (const item of actor.items ?? []) {
    const activities = item.system?.activities;
    if (!activities?.size || !Array.from(activities).some(isDescriptiveOnly)) continue;
    const text = stripEnrichers(item.system?.description?.value);
    const match = text.match(/\b(one|two|three|four|five|six|seven|eight|\d+)\b[^.]{0,25}?\battacks?\b/);
    if (!match) continue;
    const count = ATTACK_COUNT_WORDS[match[1]] ?? Number(match[1]);
    if (Number.isInteger(count) && count > 1) best = Math.max(best ?? 0, count);
  }

  return best;
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
  const a = activity?.uses ?? {};
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

    // Group this item's activities by which economy bucket they land in. An item
    // with several activities in the SAME bucket (Disguise Self: cast with a slot
    // vs. free-cast; Cunning Action: Hide/Dash/Disengage/...) collapses into one
    // item-level button that defers to dnd5e's own activity picker - the same
    // choice the character sheet's roll button offers - instead of exploding into
    // one button per activity with dnd5e's often-unhelpful default activity names
    // ("Use", "(free casting)"). Activities in DIFFERENT buckets (e.g. Net: Attack
    // = action, Utility = bonus) naturally stay separate, one per HUD section.
    const byBucket = new Map();
    for (const activity of activities) {
      const bucket = bucketFor(activity.activation?.type);
      if (!bucket) continue;
      if (isDescriptiveOnly(activity)) continue;
      if (!byBucket.has(bucket)) byBucket.set(bucket, []);
      byBucket.get(bucket).push(activity);
    }

    for (const [bucket, group] of byBucket) {
      if (group.length > 1) {
        buckets[bucket].push({
          kind: "item",
          uuid: item.uuid,
          name: item.name,
          subtitle: "",
          img: item.img,
          activityType: null,
          itemType: item.type,
          level: item.type === "spell" ? item.system.level : null,
          uses: usesFor(null, item)
        });
        continue;
      }
      const activity = group[0];
      const activityImg = activity.img && !GENERIC_ACTIVITY_ICON.test(activity.img) ? activity.img : null;
      buckets[bucket].push({
        kind: "activity",
        uuid: activity.uuid,
        name: item.name,
        subtitle: "",
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
