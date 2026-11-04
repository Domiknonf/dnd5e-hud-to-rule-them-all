import { MODULE_ID } from "./const.mjs";

/**
 * WILD MAGIC ANIMATIONS, played through Sequencer from the JB2A (Patreon or free)
 * and PSFX databases. Nothing here is required: no Sequencer, no animation. An asset
 * pack that is missing, or an entry this table cannot find in it, plays nothing.
 *
 * WHY SEARCH TERMS AND NOT DATABASE PATHS: the Patreon packs rename and add entries
 * from release to release, and a hard-coded `jb2a.foo.bar.blue` that has moved is a
 * silent no-op nobody notices. Each entry instead lists fragments of a database key,
 * best first ("fireball.explosion", then "explosion"). For each fragment the preferred
 * pack is searched before the other (setting `wildMagicAnimations`), and the first key
 * that exists wins. The answer is cached per fragment.
 *
 * `at`: where it plays.
 *   caster | target   on that token, scaled to it (`scale`)
 *   area              on the caster (or `center: "target"`), `radius` feet out
 *   line              from the caster to the target, stretched
 *   both              on the caster and on the target
 *
 * A key in the `wildMagicAnimationOverrides` setting (JSON, `{"7": "jb2a.fireball…"}`)
 * replaces the search for that entry; `"0"` is the burst played on every surge, and
 * an empty string switches one off.
 */

/** Played on the caster for every surge, before the entry's own animation. */
export const SURGE_BURST = {
  at: "caster", scale: 2.2,
  find: ["wild_magic", "wildmagic", "chaos", "magic_signs.circle.02.transmutation", "magic_signs.circle", "explosion.04", "explosion"]
};

export const SURGE_ANIMATIONS = {
  1:  { at: "caster", scale: 2, find: ["magic_signs.rune", "chaos", "energy_strands", "magic_signs"] },
  2:  { at: "both", scale: 1.5, find: ["misty_step", "teleport", "portal"] },
  3:  { at: "caster", scale: 1.5, find: ["detect_magic", "eyes", "eye"] },
  4:  { at: "caster", scale: 2, find: ["flames.", "fire_jet", "fire"] },
  5:  { at: "caster", scale: 1.5, find: ["portal", "summon", "conjuration"] },
  6:  { at: "area", radius: 20, find: ["plant_growth", "entangle", "vines", "plants"] },
  7:  { at: "area", radius: 20, find: ["fireball.explosion", "explosion.01.orange", "explosion"] },
  8:  { at: "area", radius: 60, find: ["food", "magic_signs.circle.02.transmutation", "transmutation"] },
  9:  { at: "caster", scale: 1.8, find: ["energy_strands", "magic_signs.circle", "charge"] },
  10: { at: "line", find: ["breath_weapons.fire.line", "fire_line", "fire_jet", "flames"] },
  11: { at: "caster", scale: 1.6, find: ["enlarge", "transmutation", "magic_signs"] },
  12: { at: "target", scale: 1.6, find: ["ice_spikes", "crystal", "ice", "shield"] },
  13: { at: "area", radius: 10, find: ["confusion", "markers.fear", "spirals", "swirl"] },
  14: { at: "area", radius: 20, find: ["antimagic", "dispel", "magic_signs.circle.02.abjuration"] },
  15: { at: "caster", scale: 1.6, find: ["healing_generic", "cure_wounds", "heal"] },
  16: { at: "target", scale: 1.6, find: ["portal", "misty_step", "ethereal", "teleport"] },
  17: { at: "caster", scale: 1.3, find: ["feather", "magic_signs"] },
  18: { at: "caster", scale: 2, find: ["rat", "swarm", "animal"] },
  19: { at: "area", radius: 5, find: ["grease", "puddle", "liquid"] },
  20: { at: "area", center: "target", radius: 30, find: ["entangle", "web", "magic_signs.circle.02.abjuration"] },
  21: { at: "both", scale: 1.5, find: ["shield.01", "shield", "armor"] },
  22: { at: "caster", scale: 2.5, find: ["plant_growth", "tree", "plants"] },
  23: { at: "caster", scale: 1.3, find: ["sparkles", "glint", "magic_signs"] },
  24: { at: "caster", scale: 1.3, find: ["speech", "animal", "markers"] },
  25: { at: "caster", scale: 1.3, find: ["eyes", "eye", "detect_magic"] },
  26: { at: "caster", scale: 1.5, find: ["impact.ground_crack", "ground_crack", "impact"] },
  27: { at: "caster", scale: 1.5, find: ["markers.chain", "chains", "magic_signs"] },
  28: { at: "caster", scale: 1.5, find: ["coin", "money", "sparkles"] },
  29: { at: "caster", scale: 1.6, find: ["misty_step", "teleport", "portal"] },
  30: { at: "caster", scale: 1.4, find: ["liquid", "acid", "slime", "puddle"] },
  31: { at: "caster", scale: 1.8, find: ["portal", "astral", "misty_step"] },
  32: { at: "area", radius: 30, find: ["plant_growth", "plants", "entangle"] },
  33: { at: "caster", scale: 1.8, find: ["energy_strands", "charge", "magic_signs.circle.02.evocation"] },
  34: { at: "caster", scale: 1.3, find: ["music", "notes", "speech"] },
  35: { at: "caster", scale: 1.5, find: ["time", "clock", "magic_signs.circle.02.necromancy"] },
  36: { at: "caster", scale: 1.3, find: ["horns", "antler", "magic_signs"] },
  37: { at: "area", radius: 60, find: ["markers.fear", "psychic", "confusion"] },
  38: { at: "both", scale: 1.6, find: ["thunderwave", "shockwave", "impact"] },
  39: { at: "caster", scale: 1.6, find: ["healing_generic", "cure_wounds", "heal"] },
  40: { at: "area", radius: 30, find: ["reverse_gravity", "gravity", "levitat", "energy_strands"] },
  41: { at: "caster", scale: 1.5, find: ["plant", "transmutation", "magic_signs"] },
  42: { at: "caster", scale: 1.5, find: ["swarm", "insect", "fly", "cloud"] },
  43: { at: "caster", scale: 1.6, find: ["misty_step", "teleport"] },
  44: { at: "target", scale: 1.6, find: ["impact", "ricochet", "explosion"] },
  45: { at: "caster", scale: 1.5, find: ["levitat", "wind", "energy_strands"] },
  46: { at: "caster", scale: 1.5, find: ["coin", "money", "sparkles"] },
  47: { at: "caster", scale: 2, find: ["unicorn", "horse", "sparkles"] },
  48: { at: "target", scale: 1.3, find: ["gem", "glint", "sparkles"] },
  49: { at: "caster", scale: 1.4, find: ["bubble", "markers.music", "sparkles"] },
  50: { at: "caster", scale: 1.4, find: ["smoke.puff", "smoke", "fumes"] },
  51: { at: "caster", scale: 1.5, find: ["shield.01", "shield", "magic_signs.circle.02.abjuration"] },
  52: { at: "caster", scale: 1.4, find: ["transmutation", "magic_signs"] },
  53: { at: "caster", scale: 1.6, find: ["chaos", "psychic", "magic_signs.circle.02.enchantment"] },
  54: { at: "area", radius: 60, find: ["gust", "wind", "thunderwave"] },
  55: { at: "caster", scale: 1.3, find: ["sparkles", "magic_signs"] },
  56: { at: "caster", scale: 1.6, find: ["portal", "summon", "fire"] },
  57: { at: "caster", scale: 1.5, find: ["flames.", "fire", "ember"] },
  58: { at: "caster", scale: 1.8, find: ["geyser", "water", "splash"] },
  59: { at: "caster", scale: 1.5, find: ["energy_strands", "magic_signs.circle.02.divination", "restoration"] },
  60: { at: "caster", scale: 2, find: ["summon", "portal", "conjuration"] },
  61: { at: "target", scale: 1.4, find: ["markers.music", "sound", "thunder"] },
  62: { at: "area", radius: 20, find: ["plant_growth", "grass", "plants"] },
  63: { at: "area", radius: 20, find: ["fog_cloud", "fog", "cloud"] },
  64: { at: "caster", scale: 1.4, find: ["bubble", "water", "splash"] },
  65: { at: "line", find: ["chain_lightning", "lightning_bolt", "lightning"] },
  66: { at: "target", scale: 1.4, find: ["sleep", "markers.sleep", "zzz"] },
  67: { at: "target", scale: 1.4, find: ["markers.fear", "fear", "skull"] },
  68: { at: "caster", scale: 1.2, find: ["blood", "drip", "liquid"] },
  69: { at: "area", radius: 30, find: ["invisibility", "smoke", "magic_signs.circle.02.illusion"] },
  70: { at: "area", radius: 60, find: ["markers.fear", "psychic", "shockwave"] },
  71: { at: "caster", scale: 1.6, find: ["shield.01", "warding", "protection"] },
  72: { at: "area", center: "target", radius: 20, find: ["vortex", "black_hole", "swirl", "energy_strands"] },
  73: { at: "target", scale: 1.4, find: ["poison", "markers.poison", "cloud.green"] },
  74: { at: "caster", scale: 1.3, find: ["flowers", "butterfl", "sparkles"] },
  75: { at: "area", radius: 40, find: ["light", "daylight", "radiant", "divine_smite"] },
  76: { at: "caster", scale: 1.3, find: ["magic_signs", "sparkles"] },
  77: { at: "caster", scale: 1.6, find: ["polymorph", "transmutation", "smoke.puff"] },
  78: { at: "target", scale: 1.6, find: ["explosion", "impact", "blood"] },
  79: { at: "caster", scale: 1.6, find: ["butterfl", "flowers", "sparkles"] },
  80: { at: "caster", scale: 1.6, find: ["bubble", "shield.02", "sphere", "shield"] },
  81: { at: "caster", scale: 1.6, find: ["haste", "energy_strands", "markers"] },
  82: { at: "caster", scale: 1.8, find: ["tentacle", "black_tentacles", "arms_of_hadar"] },
  83: { at: "area", center: "target", radius: 30, find: ["vampiric", "necrotic", "life_steal", "energy_strands"] },
  84: { at: "caster", scale: 1.4, find: ["markers.music", "speech", "skull"] },
  85: { at: "caster", scale: 1.5, find: ["mirror_image", "duplicat", "illusion"] },
  86: { at: "caster", scale: 1.5, find: ["jump", "impact", "transmutation"] },
  87: { at: "caster", scale: 1.5, find: ["fly", "wind", "feather"] },
  88: { at: "caster", scale: 1.4, find: ["eyes", "eye", "arcane_eye"] },
  89: { at: "target", scale: 1.4, find: ["invisibility", "smoke.puff", "magic_signs.circle.02.illusion"] },
  90: { at: "caster", scale: 1.5, find: ["magic_signs.circle.02.transmutation", "transmutation", "swap"] },
  91: { at: "caster", scale: 1.5, find: ["magic_signs.circle.02.necromancy", "necrotic", "skull"] },
  92: { at: "caster", scale: 1.4, find: ["skull", "necrotic", "markers.fear"] },
  93: { at: "caster", scale: 2.4, find: ["enlarge", "transmutation", "magic_signs"] },
  94: { at: "area", radius: 60, find: ["darkness", "smoke", "shadow"] },
  95: { at: "area", radius: 30, find: ["markers", "magic_signs.circle.02.necromancy", "curse"] },
  96: { at: "caster", scale: 1.4, find: ["markers.fear", "fear", "color"] },
  97: { at: "caster", scale: 1.5, find: ["markers.music", "music", "notes"] },
  98: { at: "caster", scale: 1.6, find: ["energy_strands", "restoration", "magic_signs.circle.02.divination"] },
  99: { at: "area", radius: 10, find: ["tiny_hut", "dome", "shield.02", "sphere"] },
  100: { at: "caster", scale: 2, find: ["portal", "chaos", "banish", "misty_step"] }
};

/* ------------------------------------------------------------------ */
/*  Lookup                                                             */
/* ------------------------------------------------------------------ */

const cache = new Map();

function sequencer() {
  return game.modules.get("sequencer")?.active ? globalThis.Sequencer : null;
}

/** Database prefixes in the order the setting asks for, only the packs installed. */
function providers() {
  const mode = game.settings.get(MODULE_ID, "wildMagicAnimations");
  if (mode === "off") return [];
  const order = mode === "psfx" ? ["psfx", "jb2a"] : ["jb2a", "psfx"];
  const db = sequencer()?.Database;
  // Only packs that registered anything: searching an absent one is wasted work.
  return order.filter(p => {
    try { return !!db?.searchFor?.(`${p}.`)?.length || !!db?.getPathsUnder?.(p)?.length; }
    catch { return false; }
  });
}

/**
 * The first database key for these fragments. A fragment that is already a complete
 * key (contains the pack prefix) is taken as is when it exists.
 */
export function findAnimation(fragments) {
  const db = sequencer()?.Database;
  if (!db) return null;
  const order = providers();
  if (!order.length) return null;
  for (const fragment of fragments) {
    const cacheKey = `${order.join(",")}|${fragment}`;
    if (cache.has(cacheKey)) {
      const hit = cache.get(cacheKey);
      if (hit) return hit;
      continue;
    }
    let hit = null;
    try {
      if (db.entryExists?.(fragment)) hit = fragment;
      if (!hit) {
        const found = db.searchFor?.(fragment) ?? [];
        const keys = (Array.isArray(found) ? found : Object.keys(found)).map(String);
        for (const prefix of order) {
          hit = keys.find(k => k.startsWith(`${prefix}.`)) ?? null;
          if (hit) break;
        }
      }
    } catch (err) {
      console.debug(`${MODULE_ID} | animation lookup "${fragment}" failed`, err);
    }
    cache.set(cacheKey, hit);
    if (hit) return hit;
  }
  return null;
}

function overrides() {
  try {
    const raw = game.settings.get(MODULE_ID, "wildMagicAnimationOverrides");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function resolve(number, spec) {
  const custom = overrides()[String(number)];
  if (typeof custom === "string") return custom.trim() || null;
  return spec ? findAnimation(spec.find) : null;
}

/* ------------------------------------------------------------------ */
/*  Playback                                                           */
/* ------------------------------------------------------------------ */

const tokenOf = (doc) => doc?.object ?? doc ?? null;

/**
 * Play the burst and the entry's own animation. Called once, on the client that rolled
 * the surge - Sequencer shares a played Sequence with everyone else itself.
 */
export async function playSurgeAnimation(number, { casterToken, targetToken } = {}) {
  const Seq = globalThis.Sequence;
  if (!sequencer() || !Seq || !canvas?.ready) return;
  const caster = tokenOf(casterToken);
  const target = tokenOf(targetToken);
  if (!caster) return;

  try {
    const seq = new Seq({ moduleName: MODULE_ID, softFail: true });
    const burst = resolve(0, SURGE_BURST);
    if (burst) seq.effect().file(burst).atLocation(caster).scaleToObject(SURGE_BURST.scale).waitUntilFinished(-600);

    const spec = SURGE_ANIMATIONS[number];
    const file = resolve(number, spec);
    if (file && spec) addEntryEffect(seq, spec, file, caster, target);
    if (!burst && !file) return;
    await seq.play();
  } catch (err) {
    console.warn(`${MODULE_ID} | wild magic animation ${number} failed`, err);
  }
}

function addEntryEffect(seq, spec, file, caster, target) {
  const other = target && target !== caster ? target : null;
  switch (spec.at) {
    case "target":
      seq.effect().file(file).atLocation(other ?? caster).scaleToObject(spec.scale ?? 1.5);
      break;
    case "both":
      seq.effect().file(file).atLocation(caster).scaleToObject(spec.scale ?? 1.5);
      if (other) seq.effect().file(file).atLocation(other).scaleToObject(spec.scale ?? 1.5);
      break;
    case "line":
      if (other) seq.effect().file(file).atLocation(caster).stretchTo(other);
      else seq.effect().file(file).atLocation(caster).scaleToObject(2);
      break;
    case "area": {
      const center = spec.center === "target" ? (other ?? caster) : caster;
      seq.effect().file(file).atLocation(center)
        .size(((spec.radius ?? 10) * 2) / (canvas.scene?.grid?.distance || 5), { gridUnits: true }).belowTokens(spec.radius >= 20);
      break;
    }
    default:
      seq.effect().file(file).atLocation(caster).scaleToObject(spec.scale ?? 1.5);
  }
}
