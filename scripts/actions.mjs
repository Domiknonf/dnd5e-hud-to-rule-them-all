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
 * The same text, but KEEPING what a content link is labelled with.
 *
 * stripEnrichers() throws the label away with the enricher, which is right for
 * counting words between a number and "attacks" - there a long [[/item .someId]] is
 * pure noise. It is exactly wrong for suggestMultiattack(), which matches on the
 * attack's NAME: statblocks name their attacks through those very links
 * ("makes two [[/item .id]]{Holy Burst} attacks"), so stripping the label deleted
 * the only words there were to match on and the suggestion came back empty.
 *
 * Two different jobs, two different strippers - not one with a flag, because the
 * one that keeps labels must never be handed to the "makes N attacks" match, where
 * a re-inserted name would widen the gap it measures.
 */
function stripToWords(text) {
  const LINK = /\[\[[^\]]*\]\]|[@&]\w+\[[^\]]*\]/;
  return (text ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(new RegExp(`(?:${LINK.source})\\{([^}]*)\\}`, "g"), " $1 ")
    .replace(new RegExp(LINK.source, "g"), " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
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

/**
 * How many attacks this specific entry grants when it OPENS an Attack action, or
 * null to use the actor-wide number.
 *
 * This is what models the alternative Multiattack - "the planetar makes two Holy
 * Burst attacks or three Radiant Sword attacks". A single number per actor cannot
 * say that; a number per entry can, because the count is decided by whichever
 * attack starts the action. Still one booking path: economy.spendAttack just gets
 * told the total instead of looking it up.
 *
 * What it deliberately does NOT model is the genuinely mixed Multiattack ("one bite
 * and two claws") - that is not a total, it is a per-entry budget, and it stays open.
 */
export function attacksForActivity(activity) {
  const n = entryConfig(activity?.actor, activity?.item, activity).attacks;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A `cast` activity that does not override its activation reports the CASTING TIME
 * OF THE SPELL it casts, not what the feature costs to use. That is why a Planetar's
 * Divine Aid - one Bonus Action feature on the sheet - arrived as several activities
 * claiming different pools.
 *
 * VERIFY AT RUNTIME if this looks wrong: `activity.activation.override` on a cast
 * activity. When the field is absent this whole rule is inert and the old
 * per-activity behaviour applies, which is deliberate - it can only ever help.
 */
function inheritsSpellActivation(activity) {
  return activity?.type === "cast" && activity.activation?.override !== true;
}

/** The activation the ITEM itself declares, ignoring echoed spell casting times. */
function ownActivation(item) {
  for (const activity of item?.system?.activities ?? []) {
    if (inheritsSpellActivation(activity)) continue;
    const type = activity.activation?.type;
    if (type) return type;
  }
  return null;
}

/**
 * The activation that actually describes what using this costs. Top level wins: if
 * the feature says what it costs, an activity echoing a spell's casting time does
 * not get to disagree.
 */
function activationFor(activity) {
  const raw = activity?.activation?.type;
  if (!inheritsSpellActivation(activity)) return raw;
  return ownActivation(activity.item) ?? raw;
}

/** Which pool an activity draws from. Configuration wins over ACTIVATION_MAP. */
export function poolFor(activity) {
  const override = entryConfig(activity?.actor, activity?.item, activity).pool;
  if (override && RESOURCES[override]) return override;
  return bucketFor(activationFor(activity));
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


/* ------------------------------------------------------------------ */
/*  The single enumeration                                             */
/* ------------------------------------------------------------------ */

/**
 * ONE list of "things this actor could have a HUD entry for". Both the bar and the
 * config dialog derive from this, and that is the whole point.
 *
 * Three separate bugs came from having two enumerations that were supposed to agree
 * and quietly did not: the config listed one row per activity where the bar showed
 * one button, it called half the passives non-passive, and it listed dnd5e's cached
 * spell copies that the bar deliberately hides. Each was patched individually; the
 * class of bug only goes away by removing the second list.
 *
 * An entry is one BUTTON: an item plus the group of its activities that share a
 * pool. An item whose activities all agree is one entry; one that spans pools (a
 * Planetar's Divine Aid: some at-will, some as a bonus action) is one entry per
 * pool, which is exactly how the bar draws it.
 *
 * `pool` is the effective pool - configuration already applied - or null for
 * "nowhere", which is what an out-of-combat activation gets. `keys` lists every
 * config key a rule has to be written to for this button, since a grouped button
 * covers several activities.
 */
export function enumerateEntries(actor) {
  const entries = [];
  if (!actor) return entries;
  const produced = new Set();

  const make = (item, activities, pool, passive = false, allActivities = activities) => {
    const first = activities[0] ?? null;
    const rule = entryConfig(actor, item, first);
    produced.add(item.id);
    return {
      key: activities.length ? entryKey(item, first) : entryKey(item),
      keys: activities.length ? activities.map(a => entryKey(item, a)) : [entryKey(item)],
      // The item-level key, plus every activity key the item has - not just this
      // group's. A rule set on the item covers activities it grows later, which a
      // pile of per-activity rules never can.
      itemKey: entryKey(item),
      allKeys: allActivities.map(a => entryKey(item, a)),
      item, activities, pool, passive,
      // Whether there is anything to fire. Governs one thing only: may this be
      // dragged into a pool. A passive feat that does carry activities can be.
      usable: activities.length > 0,
      hidden: rule.hidden === true,
      sort: Number.isFinite(rule.sort) ? rule.sort : null,
      auto: {
        pool: passive ? "passive" : (first ? bucketFor(activationFor(first)) : null),
        attack: activities.some(a => a.type === "attack") || isAttackSubstituteItem(item)
      },
      attack: activities.some(countsAsAttack),
      attackOverridden: typeof rule.attack === "boolean",
      // How many attacks ONE Attack action grants when this entry starts it. Null
      // means "use the actor's number" (config.attacksPerAction / detection).
      attacks: Number.isFinite(rule.attacks) ? rule.attacks : null,
      poolOverridden: !!rule.pool
    };
  };

  for (const item of actor.items) {
    if (!item.system?.activities?.size) continue;
    // Same filter the bar uses - this is where the cached NPC-spellcasting copies
    // get dropped, and skipping it here is what put them in the dialog.
    if (!isUsable(item)) continue;
    const activities = [...item.system.activities].filter(a => !isDescriptiveOnly(a));
    if (!activities.length) continue;

    const byPool = new Map();
    const unpooled = [];
    for (const activity of activities) {
      const pool = poolFor(activity);
      if (!pool) { unpooled.push(activity); continue; }
      if (!byPool.has(pool)) byPool.set(pool, []);
      byPool.get(pool).push(activity);
    }

    if (byPool.size) {
      for (const [pool, group] of byPool) entries.push(make(item, group, pool, false, activities));
      if (unpooled.length) entries.push(make(item, unpooled, null, false, activities));
      continue;
    }
    // Nothing lands anywhere. A feat drops through to the passive section - whether
    // it carries unusable activities (Cunning Strike) or none makes no difference to
    // where it is shown. Anything else is simply off the bar.
    entries.push(make(item, activities, item.type === "feat" ? "passive" : null, item.type === "feat"));
  }

  // Feats that produced nothing above: no activities at all, or only descriptive
  // ones (an NPC's Multiattack blurb).
  for (const item of actor.items) {
    if (item.type !== "feat" || produced.has(item.id)) continue;
    entries.push(make(item, [], "passive", true));
  }

  return entries;
}

/**
 * Which configurable ENTRY an activity belongs to. The Multiattack options are
 * written against entry keys, and a grouped button covers several activities, so
 * the booking path has to map back before it can look anything up.
 */
export function entryKeyForActivity(activity) {
  const item = activity?.item;
  if (!item) return null;
  const own = entryKey(item, activity);
  return enumerateEntries(item.actor).find(e => e.keys.includes(own))?.key ?? own;
}

/**
 * A first draft of the Multiattack from the statblock's own text, for the dialog to
 * prefill. SRD phrasing is "makes two Holy Burst attacks or three Radiant Sword
 * attacks", so each attack entry is looked for by name with a count in front of it.
 *
 * "or" is what separates the alternatives, and it is the one structural marker the
 * text reliably has - so it, not the number of matches, decides where an option
 * ends. Everything named within one chunk is COMBINED into a single option ("one
 * bite and two claws" is one alternative with two parts); the chunks themselves are
 * the choice. Treating every match as its own alternative instead was silently
 * wrong for the AND case: it offered a creature two Multiattacks that each allowed
 * half of the one it actually has.
 *
 * A suggestion, nothing more: it never writes anything, and the dialog exists
 * precisely so the reading can be corrected.
 */
export function suggestMultiattack(actor) {
  const attacks = enumerateEntries(actor).filter(e => e.pool === "action" && e.attack);
  if (!attacks.length) return [];

  let text = "";
  for (const item of actor?.items ?? []) {
    const activities = item.system?.activities;
    if (!activities?.size || !Array.from(activities).some(isDescriptiveOnly)) continue;
    text = stripToWords(item.system?.description?.value);
    if (text) break;
  }
  if (!text) return [];

  const options = [];
  for (const chunk of text.split(/\bor\b/)) {
    const parts = [];
    for (const entry of attacks) {
      const name = entry.item.name?.trim().toLowerCase();
      if (!name) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = chunk.match(new RegExp(`\\b(one|two|three|four|five|six|seven|eight|\\d+)\\b[^.]{0,20}?${escaped}`));
      if (!match) continue;
      const count = ATTACK_COUNT_WORDS[match[1]] ?? Number(match[1]);
      if (Number.isInteger(count) && count > 0) parts.push({ key: entry.key, count });
    }
    if (parts.length) options.push({ parts });
  }
  return options;
}

/** Activity name, but only when it adds something the item name does not. */
function activityLabel(entry) {
  if (entry.activities.length !== 1) return "";
  const name = entry.activities[0].name;
  return name && name !== entry.item.name ? name : "";
}

function entryImage(entry) {
  if (entry.activities.length === 1) {
    const img = entry.activities[0].img;
    if (img && !GENERIC_ACTIVITY_ICON.test(img)) return img;
  }
  return entry.item.img;
}

/* ------------------------------------------------------------------ */
/*  Consumers                                                          */
/* ------------------------------------------------------------------ */

export function collectActions(actor) {
  const buckets = {};
  for (const key of Object.keys(RESOURCES)) buckets[key] = [];
  if (!actor) return buckets;

  for (const entry of enumerateEntries(actor)) {
    if (entry.hidden || !entry.pool || !buckets[entry.pool]) continue;
    const { item, activities } = entry;
    // A group of several activities collapses into one item-level button that defers
    // to dnd5e's own activity picker - the same choice the sheet's roll button
    // offers - instead of exploding into one button per activity with dnd5e's often
    // unhelpful default names ("Use", "(free casting)").
    const single = activities.length === 1 ? activities[0] : null;
    const passive = entry.pool === "passive";

    buckets[entry.pool].push({
      kind: passive ? "passive" : (single ? "activity" : "item"),
      action: passive ? "describe" : "use",
      uuid: single && !passive ? single.uuid : item.uuid,
      name: item.name,
      subtitle: "",
      img: entryImage(entry),
      activityType: single?.type ?? null,
      itemType: item.type,
      level: item.type === "spell" ? item.system.level : null,
      uses: usesFor(single, item),
      details: single ? detailsFor(single) : null,
      description: plainDescription(item),
      key: entry.key,
      countsAsAttack: entry.attack,
      attacks: entry.attacks,
      sort: entry.sort
    });
  }

  const alphabetical = game.settings.get(MODULE_ID, "sortAlphabetically");
  for (const key of Object.keys(buckets)) {
    // A configured position always wins; everything else keeps sheet order, or goes
    // A-Z when that setting is on. Array#sort is stable, so "no opinion" really does
    // mean "leave it alone".
    buckets[key].sort((a, b) => {
      const as = a.sort ?? Infinity;
      const bs = b.sort ?? Infinity;
      if (as !== bs) return as - bs;
      return alphabetical ? a.name.localeCompare(b.name) : 0;
    });
  }
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
 * The same entries, shaped for the config dialog. One row per BUTTON, including the
 * hidden ones (nothing could be un-hidden otherwise) and the ones with no pool.
 */
export function collectConfigurable(actor) {
  const entries = enumerateEntries(actor);
  // How many buttons one item produces. Anything above 1 means its activities
  // disagree about which pool they cost - a Planetar's Divine Aid, whose `cast`
  // activities each report the CASTING TIME OF THE SPELL rather than what the
  // feature costs. The dialog surfaces that instead of letting it look like two
  // unrelated things.
  const perItem = new Map();
  for (const e of entries) perItem.set(e.item.id, (perItem.get(e.item.id) ?? 0) + 1);

  return entries
    .map(entry => ({
      key: entry.key,
      keys: entry.keys,
      itemKey: entry.itemKey,
      allKeys: entry.allKeys,
      split: (perItem.get(entry.item.id) ?? 1) > 1,
      name: entry.item.name,
      detail: activityLabel(entry),
      img: entryImage(entry),
      pool: entry.pool,
      passive: entry.pool === "passive",
      usable: entry.usable,
      hidden: entry.hidden,
      sort: entry.sort,
      attack: entry.attack,
      attacks: entry.attacks,
      attackOverridden: entry.attackOverridden,
      poolOverridden: entry.poolOverridden,
      auto: entry.auto
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.detail.localeCompare(b.detail));
}
