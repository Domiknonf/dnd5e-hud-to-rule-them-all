import {
  MODULE_ID, RESOURCES, ACTIVATION_MAP, OUT_OF_COMBAT_ACTIVATIONS,
  GENERIC_ACTIVITY_ICON, ATTACK_SUBSTITUTE_NAMES
} from "./const.mjs";
import { entryConfig, entryKey } from "./config.mjs";

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
 *
 * Returns `{ count, feature }` or null. The feature NAME rides along because the
 * config dialog quotes it back ("New feature: Two Extra Attacks -> 3 attacks
 * recommended") - a bare number gives the player nothing to check against their
 * character sheet. Both strategies are guesses, not structured data:
 * config.attacksPerAction (see economy.getAttacksPerAction) always wins.
 */
export function guessAttacksPerAction(actor) {
  if (!actor) return null;
  // Take the highest match, not the first: a Fighter past level 11 may carry both
  // the base "Extra Attack" and an upgrade feature like "Two Extra Attacks" at
  // once, and iteration order isn't guaranteed to put the current tier first.
  let best = null;
  const consider = (count, item) => {
    if (!Number.isInteger(count) || count <= (best?.count ?? 0)) return;
    best = { count, feature: item.name ?? "" };
  };

  if (actor.type === "character") {
    for (const item of actor.items ?? []) {
      consider(PC_EXTRA_ATTACK_NAMES[item.name?.trim().toLowerCase()], item);
    }
  }

  for (const item of actor.items ?? []) {
    const activities = item.system?.activities;
    if (!activities?.size || !Array.from(activities).some(isDescriptiveOnly)) continue;
    const text = stripEnrichers(item.system?.description?.value);
    const match = text.match(/\b(one|two|three|four|five|six|seven|eight|\d+)\b[^.]{0,25}?\battacks?\b/);
    if (!match) continue;
    const count = ATTACK_COUNT_WORDS[match[1]] ?? Number(match[1]);
    if (count > 1) consider(count, item);
  }

  return best;
}

/**
 * Whether this item's activities may replace one attack inside the Attack action
 * (see ATTACK_SUBSTITUTE_NAMES). Player Characters only: the substitute rule is a
 * PC racial trait, while an NPC's breath weapon is its own full action.
 *
 * This is now only the DEFAULT for countsAsAttack() below - a hardcoded English name
 * list can never cover homebrew, so the per-entry override is the real answer and
 * this just keeps SRD content right out of the box.
 */
export function isAttackSubstituteItem(item) {
  if (item?.actor?.type !== "character") return false;
  return ATTACK_SUBSTITUTE_NAMES.has((item.name ?? "").trim().toLowerCase());
}

/**
 * Does using this consume one attack within the Attack action (rather than a fresh
 * action of its own)? Configuration wins; detection is the fallback.
 */
export function countsAsAttack(activity) {
  const override = entryConfig(activity?.actor, activity?.item, activity).attack;
  if (typeof override === "boolean") return override;
  return activity?.type === "attack" || isAttackSubstituteItem(activity?.item);
}

/** Which pool an activity draws from. Configuration wins over ACTIVATION_MAP. */
export function poolFor(activity) {
  const override = entryConfig(activity?.actor, activity?.item, activity).pool;
  if (override && RESOURCES[override]) return override;
  return bucketFor(activity?.activation?.type);
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

/**
 * BG3-style hover-card details. dnd5e precomputes localized labels on each
 * activity during data prep (activity.labels.range/.target/...); those are read
 * first and the raw structured fields serve as fallback, so a missing label
 * degrades to something legible instead of an empty row. Every field is optional
 * - the HUD omits rows it has no value for.
 */
function detailsFor(activity) {
  if (!activity) return null;
  const labels = activity.labels ?? {};
  const details = {
    range: labels.range || rangeLabel(activity.range),
    target: labels.target || targetLabel(activity.target),
    damage: damageLabel(activity)
  };
  for (const k of Object.keys(details)) if (!details[k]) delete details[k];
  return Object.keys(details).length ? details : null;
}

function rangeLabel(range) {
  const value = range?.value ?? range?.reach;
  if (!value) return "";
  const units = CONFIG.DND5E?.movementUnits?.[range?.units]?.abbreviation ?? range?.units ?? "";
  return `${value} ${units}`.trim();
}

function targetLabel(target) {
  const tpl = target?.template;
  if (tpl?.type) {
    const shape = CONFIG.DND5E?.areaTargetTypes?.[tpl.type]?.label ?? tpl.type;
    const size = tpl.size ? `${tpl.size} ${tpl.units ?? ""}`.trim() : "";
    return [size, game.i18n.localize(shape)].filter(Boolean).join(" ");
  }
  const affects = target?.affects;
  if (affects?.type) {
    const cfg = CONFIG.DND5E?.individualTargetTypes?.[affects.type];
    const label = game.i18n.localize(cfg?.label ?? cfg ?? affects.type);
    return [affects.count, label].filter(Boolean).join(" ");
  }
  return "";
}

function damageLabel(activity) {
  const parts = activity?.damage?.parts ?? (activity?.healing ? [activity.healing] : []);
  return parts.map(p => {
    const types = [...(p?.types ?? [])]
      .map(t => game.i18n.localize(CONFIG.DND5E?.damageTypes?.[t]?.label ?? CONFIG.DND5E?.healingTypes?.[t]?.label ?? t));
    return [p?.formula ?? "", types.join("/")].filter(Boolean).join(" ");
  }).filter(Boolean).join(", ");
}

/**
 * Plain-text preview of the item's description for the hover card. Enrichment
 * (@UUID links, [[/roll]] inline rolls) is deliberately NOT run - it is async and
 * would have to fire on every render for every entry. Instead the enricher's label
 * is kept (or the enricher dropped) and the text clamped at a word boundary.
 */
function plainDescription(item) {
  let text = item.system?.description?.value ?? "";
  text = text
    .replace(/<[^>]+>/g, " ")
    .replace(/(@\w+\[[^\]]*\]|\[\[[^\]]*\]\])\{([^}]*)\}/g, "$2")
    .replace(/@\w+\[[^\]]*\]|\[\[[^\]]*\]\]/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > 300) text = `${text.slice(0, 300).replace(/\s+\S*$/, "")}…`;
  return text;
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

  const bucketedItems = new Set();

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
    // Hiding the item hides everything on it; a per-activity flag is checked below.
    if (entryConfig(actor, item).hidden) continue;

    const byBucket = new Map();
    for (const activity of activities) {
      if (isDescriptiveOnly(activity)) continue;
      if (entryConfig(actor, item, activity).hidden) continue;
      // poolFor(), not bucketFor(): a configured pool overrides ACTIVATION_MAP, and
      // it does so here so the entry lands in the right HUD section AND is grouped
      // with whatever else the item puts in that same section.
      const bucket = poolFor(activity);
      if (!bucket) continue;
      if (!byBucket.has(bucket)) byBucket.set(bucket, []);
      byBucket.get(bucket).push(activity);
    }

    for (const [bucket, group] of byBucket) {
      bucketedItems.add(item.id);
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
          uses: usesFor(null, item),
          description: plainDescription(item),
          // The button fires dnd5e's activity picker, so any attack in the group
          // makes the whole button behave as one for affordability purposes.
          countsAsAttack: group.some(countsAsAttack)
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
        uses: usesFor(activity, item),
        details: detailsFor(activity),
        description: plainDescription(item),
        countsAsAttack: countsAsAttack(activity)
      });
    }
  }

  // Passive, "good to know" features (Tactical Shift, Fighting Styles, ...):
  // feat-type items that produced no usable entry above - either no activities at
  // all or only out-of-combat ones. They can't be used or booked, so both left and
  // middle click open the description card ("describe" instead of "use").
  for (const item of actor.items) {
    if (item.type !== "feat" || bucketedItems.has(item.id)) continue;
    if (entryConfig(actor, item).hidden) continue;
    buckets.passive.push({
      kind: "passive",
      action: "describe",
      uuid: item.uuid,
      name: item.name,
      subtitle: "",
      img: item.img,
      activityType: null,
      itemType: item.type,
      level: null,
      uses: usesFor(null, item),
      description: plainDescription(item)
    });
  }

  const sort = game.settings.get(MODULE_ID, "sortAlphabetically");
  if (sort) for (const key of Object.keys(buckets)) buckets[key].sort((a, b) => a.name.localeCompare(b.name));
  return buckets;
}

/**
 * Used by the economy watcher to know what a used activity costs. Goes through
 * poolFor(), so a reassigned entry books against the pool it was moved to no matter
 * where it was used from - sheet, macro or HUD.
 *
 * Note this deliberately ignores the `hidden` flag: hiding something removes it from
 * the bar, it does not make it free.
 */
export function costOfActivity(activity) {
  if (isDescriptiveOnly(activity)) return null;
  return poolFor(activity);
}

/**
 * Everything on this actor the config dialog can offer a rule for, including what is
 * currently hidden (otherwise nothing could ever be un-hidden) and what the world
 * filters drop. One row per activity, plus one per activity-less feat so passive
 * entries can be hidden too.
 */
export function collectConfigurable(actor) {
  const rows = [];
  if (!actor) return rows;

  for (const item of actor.items) {
    const activities = [...(item.system?.activities ?? [])].filter(a => !isDescriptiveOnly(a));
    if (!activities.length) {
      if (item.type !== "feat") continue;
      rows.push({
        key: entryKey(item), name: item.name, img: item.img,
        detail: game.i18n.localize(`${MODULE_ID}.pool.passive`),
        auto: { pool: "passive", attack: false }, passive: true
      });
      continue;
    }
    for (const activity of activities) {
      // Only name the activity when it adds something: dnd5e seeds a lot of them
      // with the item's own name, and "Longsword - Longsword" helps nobody.
      const label = activity.name && activity.name !== item.name ? activity.name : "";
      rows.push({
        key: entryKey(item, activity),
        name: item.name,
        detail: label,
        img: (activity.img && !GENERIC_ACTIVITY_ICON.test(activity.img) ? activity.img : null) || item.img,
        auto: {
          pool: bucketFor(activity.activation?.type),
          attack: activity.type === "attack" || isAttackSubstituteItem(item)
        }
      });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.detail.localeCompare(b.detail));
}
