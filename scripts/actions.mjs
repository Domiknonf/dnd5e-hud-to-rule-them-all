import {
  MODULE_ID, RESOURCES, ACTIVATION_MAP, OUT_OF_COMBAT_ACTIVATIONS, INTRINSIC_ACTIONS
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

/** Cheap availability filter. Extend this — it is where most house rules land. */
function isUsable(item) {
  if (item.system?.equipped === false && game.settings.get(MODULE_ID, "hideUnequipped")) return false;
  if (item.type === "spell" && game.settings.get(MODULE_ID, "hideUnprepared")) {
    const prep = item.system?.preparation ?? {};
    const alwaysAvailable = ["always", "atwill", "innate", "pact", "ritual"];
    if (!alwaysAvailable.includes(prep.mode) && prep.prepared === false && (item.system.level ?? 0) > 0) return false;
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

    for (const activity of activities) {
      const bucket = bucketFor(activity.activation?.type);
      if (!bucket) continue;
      const name = activity.name || item.name;
      buckets[bucket].push({
        kind: "activity",
        uuid: activity.uuid,
        name,
        subtitle: name === item.name ? "" : item.name,
        img: activity.img || item.img,
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
  return bucketFor(activity?.activation?.type);
}
