import { MODULE_ID } from "./const.mjs";
import { applyToTargets } from "./effects.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * Who an activity is aimed at, read from its own data - dnd5e 5.x keeps it in
 * activity.target ({ affects, template }) and activity.range. The HUD asks this
 * BEFORE calling use(), because dnd5e snapshots game.user.targets into the usage
 * card's flags (Activity#messageFlags) and an attack snapshots them again the moment
 * it rolls - both happen inside use(), so targets set afterwards reach neither.
 *
 * What the 2024 compendium content actually contains (surveyed over spells24,
 * classes24, feats24, equipment24, monsterfeatures24) decided the rules below, and
 * two findings shaped them more than the field names did:
 * - "range: self" does NOT mean "targets yourself". Stunning Strike, Sneak Attack,
 *   Divine Smite, Lay on Hands and the healing potions all carry range self with a
 *   creature (or no) target - they are riders on the attack you just made, or
 *   touch effects entered as self. Only affects.type "self" is unambiguous.
 * - The count is a formula of the CAST level ("2 + @item.level" for Bless), so before
 *   the slot dialog has run it reads as the base level's count. See maxCount.
 *
 * Plans:
 *   self - the caster's own token, set without asking.
 *   pick - a creature picker: `filter`, `count` (null = any number), `range` in scene
 *          units (null = unlimited), `soft` range for touch (marked, not enforced).
 *   area - dnd5e places the template; the tokens inside are targeted once it lands.
 *   none - nothing to aim at (a summon's space, a teleport's destination, a
 *          description-only feature). The user's targets are left alone.
 */
export function targetPlan(activity) {
  if (!activity) return { kind: "none" };
  const affects = activity.target?.affects ?? {};
  const template = activity.target?.template ?? {};
  const units = activity.range?.units ?? "";
  const type = affects.type || "";
  const count = Number(affects.count) > 0 ? Number(affects.count) : null;

  // Detect Magic and the auras are a radius ON the caster with target "self": the
  // area moves with you and is not an attack on anyone in it.
  if (type === "self") return { kind: "self" };

  if (template.type) {
    // Gate, Prismatic Wall: the area is a place, nobody in it is affected by casting.
    if (type === "space") return { kind: "none" };
    return {
      kind: "area",
      filter: filterFor(type),
      count,
      choice: !!affects.choice,
      // 2024 rules: the point of origin of a Cone, Line or Cube, and the creator of an
      // Emanation, are not in the area unless its creator decides otherwise - so an
      // area that starts at you (Burning Hands, Lightning Bolt, Thunderwave, Spirit
      // Guardians, a breath weapon) leaves you out. A Sphere or Cylinder cast at range
      // has no such clause: a Fireball at your own feet catches you. "You and your
      // allies" auras (Aura of Protection, type "ally") say otherwise, and keep you.
      fromSelf: units === "self",
      includeSelf: type === "ally" || type === "willing"
    };
  }

  // Misty Step, Dimension Door's destination, Spiritual Weapon's summon point.
  if (type === "space") return { kind: "none" };

  if (type) {
    // No count means "any number" (Beacon of Hope, Create Undead's command), EXCEPT
    // where the activity only reaches as far as you can touch: a potion handed over,
    // a rider on the creature you just hit - always exactly one.
    const n = count ?? (units === "self" || units === "touch" ? 1 : null);
    return {
      kind: "pick",
      filter: filterFor(type),
      count: n,
      maxCount: maxCount(activity, n),
      ...rangeOf(activity),
      // Nearest-first would otherwise put the attacker at the top of its own list.
      excludeSelf: activity.type === "attack",
      // Where the picker starts (see beforeUse). A buff or a heal you deliver by hand
      // - Protection from Evil and Good, Cure Wounds, a potion, Lay on Hands - is most
      // often for yourself.
      preferSelf: (units === "self" || units === "touch") && SELF_FIRST_TYPES.has(activity.type),
      // A rider on the attack you just made (Sneak Attack, Stunning Strike, Divine
      // Strike) applies to exactly the creature that attack was aimed at - the one
      // case where the previous target is the right answer rather than a leftover.
      rider: units === "self" && !SELF_FIRST_TYPES.has(activity.type)
    };
  }

  // A weapon or spell attack without a stated target is still one roll against one
  // AC (every weapon, Chromatic Orb, Acid Arrow, True Strike's weapon swing).
  if (activity.type === "attack") return {
    kind: "pick", filter: "any", count: 1, maxCount: 1, ...rangeOf(activity), excludeSelf: true, preferSelf: false
  };

  // Nothing targeted and range self: Rage, Second Wind, Action Surge, Mirror Image.
  // Limited to activity types that cannot hurt anyone - a "damage, range self, no
  // target" activity is Divine Smite's rider, and targeting yourself there would put
  // the damage application on your own token.
  if (units === "self" && SELF_RANGE_TYPES.has(activity.type)) return { kind: "self" };

  return { kind: "none" };
}

/**
 * Activity types that, with range self and no target, act on their user. "cast" is
 * deliberately absent: a wand or scroll takes range and target from its cached spell,
 * and when that cache is missing the defaults (range self, no target) say nothing -
 * a Wand of Magic Missiles must not end up aimed at its wielder.
 */
const SELF_RANGE_TYPES = new Set(["utility", "heal", "enchant", "check"]);

/**
 * Activity types where a self- or touch-range picker starts with the caster selected;
 * with range self, every other type is a rider on an attack (see targetPlan).
 */
const SELF_FIRST_TYPES = new Set(["heal", "utility"]);

/**
 * Which creatures a target type admits. "willing" is not a disposition - any creature
 * can be willing - so it is offered everything a "creature" is.
 */
function filterFor(type) {
  if (type === "ally") return "ally";
  if (type === "enemy") return "enemy";
  if (type === "creature" || type === "willing") return "creature";
  return "any";
}

/**
 * The range the picker measures against, in the scene's own units.
 * - feet/metres/miles: the activity's value. For a weapon dnd5e has already folded
 *   long range (or reach, for a melee weapon) into range.value during prepareFinalData.
 * - touch: one grid step, shown but not enforced - reach weapons and big creatures
 *   make "touch" longer than five feet often enough.
 * - self with a creature target: a rider on an attack you just made, whose range was
 *   that attack's. No limit.
 * - any, special, unset: no limit.
 */
function rangeOf(activity) {
  const { units, value } = activity.range ?? {};
  if (units === "touch") return { range: canvas?.grid?.distance ?? 5, soft: true };
  if (!(units in (CONFIG.DND5E?.movementUnits ?? {})) || !(Number(value) > 0)) return { range: null };
  return { range: toSceneUnits(Number(value), units), soft: false };
}

function toSceneUnits(value, units) {
  const scene = canvas?.scene?.grid?.units;
  if (!scene || scene === units || !(scene in (CONFIG.DND5E?.movementUnits ?? {}))) return value;
  try {
    return globalThis.dnd5e?.utils?.convertLength?.(value, units, scene, { strict: false }) ?? value;
  } catch {
    return value;
  }
}

/**
 * The most targets this activity can take at the highest slot the caster can still
 * spend. Bless is "2 + @item.level" - three at 1st level, four from a 2nd-level slot -
 * and the slot is picked in dnd5e's usage dialog, which runs inside use(), after the
 * picker. So the picker allows the upcast count, and reportOvercount() checks the
 * real slot once use() returns.
 */
function maxCount(activity, count) {
  const formula = countFormula(activity);
  if (!count || !activity.requiresSpellSlot || !/@item\.level\b/.test(formula ?? "")) return count;
  const base = activity.item?.system?.level ?? 0;
  const top = highestSlot(activity.actor, base);
  return top > base ? (countAtLevel(activity, top) ?? count) : count;
}

/** The unprepared count formula - the prepared one has already been reduced to a number. */
function countFormula(activity) {
  const target = activity.target;
  // Not overriding means dnd5e copied the item's target over the activity's (see
  // BaseActivityData#_setOverride), so the formula lives on the item.
  if (target?.canOverride && !target.override) return activity.item?._source?.system?.target?.affects?.count;
  return activity._source?.target?.affects?.count;
}

function countAtLevel(activity, level) {
  const formula = countFormula(activity);
  const simplify = globalThis.dnd5e?.utils?.simplifyBonus;
  if (!formula || typeof simplify !== "function") return null;
  const data = foundry.utils.deepClone(activity.getRollData?.({ deterministic: true }) ?? {});
  foundry.utils.setProperty(data, "item.level", level);
  const n = simplify(formula, data);
  return n > 0 ? n : null;
}

function highestSlot(actor, base) {
  let top = base;
  for (const slot of Object.values(actor?.system?.spells ?? {})) {
    if ((slot?.value ?? 0) > 0 && (slot?.level ?? 0) > top) top = slot.level;
  }
  return top;
}

/* -------------------------------------------- */
/*  Tokens and distances                         */
/* -------------------------------------------- */

/**
 * The caster's token on the viewed scene: the one the user has selected if it stands
 * for this actor, then the synthetic actor's own token, then any token of it.
 */
export function casterToken(actor) {
  if (!actor || !canvas?.ready) return null;
  const controlled = canvas.tokens.controlled.find(t => t.actor === actor);
  if (controlled) return controlled;
  if (actor.token?.object && actor.token.parent === canvas.scene) return actor.token.object;
  return actor.getActiveTokens?.(true)?.[0] ?? null;
}

/** Centres of every grid space a token covers - one point on a gridless scene. */
function spaceCenters(token) {
  const doc = token.document;
  if (!canvas.grid.isGridless && typeof doc.getOccupiedGridSpaceOffsets === "function") {
    const offsets = doc.getOccupiedGridSpaceOffsets();
    if (offsets?.length) return offsets.map(o => canvas.grid.getCenterPoint(o));
  }
  return [token.center];
}

/**
 * Distance between two creatures the way the rules count it: from the nearest
 * space of one to the nearest space of the other, so two adjacent creatures are 5 ft
 * apart and a Large ogre's reach starts at its own edge. On a gridless scene the
 * same is approximated from the centres minus the extra width of each token.
 */
export function distanceBetween(a, b) {
  if (!a || !b) return null;
  if (a === b) return 0;
  const measure = (p, q) => canvas.grid.measurePath([p, q]).distance;
  if (canvas.grid.isGridless) {
    const step = canvas.grid.distance;
    const extra = ((a.document.width - 1) + (b.document.width - 1)) * step / 2;
    return Math.max(step, measure(a.center, b.center) - extra);
  }
  let best = Infinity;
  for (const p of spaceCenters(a)) for (const q of spaceCenters(b)) best = Math.min(best, measure(p, q));
  return best;
}

/** Tokens the user can see and the plan's filter admits, nearest first. */
function candidates(plan, caster) {
  if (!canvas?.ready) return [];
  const D = CONST.TOKEN_DISPOSITIONS;
  const own = caster?.document.disposition;
  return canvas.tokens.placeables
    .filter(t => t.actor && t.visible && (!t.document.hidden || game.user.isGM))
    .filter(t => {
      if (plan.excludeSelf && t === caster) return false;
      if (plan.filter === "ally") return !caster || t === caster || t.document.disposition === own;
      // Neutral counts as a possible enemy: nothing stops you from attacking one.
      if (plan.filter === "enemy") return t !== caster && (!caster || t.document.disposition !== own)
        && t.document.disposition !== D.SECRET;
      return true;
    })
    .map(token => ({ token, distance: distanceBetween(caster, token) }))
    .sort((x, y) => (x.distance ?? Infinity) - (y.distance ?? Infinity));
}

/* -------------------------------------------- */
/*  Setting the targets                          */
/* -------------------------------------------- */

/**
 * Replace the user's targets. v13's TokenLayer#setTargets does it in one call and one
 * broadcast; the per-token fallback is the pre-v13 path, kept for safety.
 */
export function setTargets(ids) {
  const layer = canvas?.tokens;
  if (!layer) return;
  if (typeof layer.setTargets === "function") return layer.setTargets(ids, { mode: "replace" });
  const keep = new Set(ids);
  for (const t of [...game.user.targets]) {
    if (!keep.has(t.id)) t.setTarget(false, { releaseOthers: false, groupSelection: true });
  }
  for (const id of keep) layer.get(id)?.setTarget(true, { releaseOthers: false, groupSelection: true });
  game.user.broadcastActivity?.({ targets: [...keep] });
}

const currentTargetIds = () => [...game.user.targets].map(t => t.id);

/** Setting: "always" asks every time, "missing" only when the targets do not fit, "off". */
const mode = () => game.settings.get(MODULE_ID, "targetPicker");

/**
 * Before use(): aim the activity. Resolves to the plan to carry into afterUse(), or
 * false when the user cancelled the picker - the usage is then not made at all.
 *
 * Every click starts from a clean slate. Targets left over from the last spell are
 * not a choice about this one: three allies still targeted from Bless are NOT who
 * Protection from Evil and Good is meant for, and preselecting them made a quick
 * Enter cast it on the wrong creature. So the picker opens empty, or on yourself for
 * a touch buff or heal, and only an attack rider keeps the creature just attacked.
 * An activity that aims at nothing (Misty Step, a summon) clears them as well, so
 * its chat card does not claim targets it never had.
 *
 * Shift-click skips the picker (dnd5e's own "fast-forward" modifier) and keeps
 * whatever is targeted - the path for targeting on the canvas first. The "missing"
 * mode keeps the old behaviour: current targets that fit are used without asking.
 */
export async function beforeUse(activity, event) {
  if (mode() === "off" || !canvas?.ready) return { kind: "none" };
  const plan = targetPlan(activity);
  const caster = casterToken(activity.actor);

  if (plan.kind === "self") {
    setTargets(caster ? [caster.id] : []);
    return plan;
  }
  // The usage card snapshots targets before the template is even placed; clearing
  // them here keeps a stale target from the last attack off a Fireball's card.
  if (plan.kind === "area") {
    setTargets([]);
    return plan;
  }
  if (event?.shiftKey) return plan;
  if (plan.kind !== "pick") {
    if (mode() === "always") setTargets([]);
    return plan;
  }

  const pool = candidates(plan, caster);
  const allowed = new Set(pool.map(c => c.token.id));
  const limit = plan.maxCount ?? plan.count;
  const current = currentTargetIds().filter(id => allowed.has(id));
  const fits = current.length > 0 && (!limit || current.length <= limit);
  if (mode() === "missing" && fits) return plan;

  let preselect = [];
  if (plan.rider) preselect = current;
  else if (plan.preferSelf && caster && allowed.has(caster.id)) preselect = [caster.id];
  if (limit) preselect = preselect.slice(0, limit);
  // The picker replaces the canvas targets with `preselect` as it opens, so only
  // what is being chosen shows - and puts the old ones back on Cancel.

  const chosen = await pickTargets({ activity, plan, pool, caster, preselect });
  if (chosen === null) return false;
  setTargets(chosen);
  return { ...plan, chosen };
}

/**
 * After use(): fill an area with what it caught, and check a picked count against
 * the slot that was really spent.
 */
export async function afterUse(activity, plan, results) {
  if (!results || !plan) return;
  // Buffs and heals land on who they were aimed at - yourself for a self effect, the
  // picked creatures otherwise (see effects.applyToTargets). Not for an aim-less
  // activity, where whatever is targeted was never chosen for it.
  if ((plan.kind === "self" || plan.kind === "pick") && mode() !== "off") {
    await applyToTargets(activity, results);
  }
  if (plan.kind === "pick" && plan.chosen) return reportOvercount(activity, plan, results);
  if (plan.kind !== "area") return;
  const templates = results.templates ?? [];
  if (!templates.length) return;
  // Midi QoL targets the tokens in a placed template itself (its "auto target"
  // option); doing it twice would fight over the result.
  if (game.modules.get("midi-qol")?.active) return;

  const caster = casterToken(activity.actor);
  let inside = candidates(plan, caster)
    .filter(({ token }) => templates.some(doc => insideTemplate(token, doc)));
  if (plan.fromSelf && !plan.includeSelf) inside = inside.filter(c => c.token !== caster);

  let ids = inside.map(c => c.token.id);
  const limited = plan.count && ids.length > plan.count;
  // "Creatures of your choice" (Spirit Guardians, Holy Aura) and "one creature in the
  // cube" (Phantasmal Force): hand the catch to the picker, all of it preselected.
  if ((plan.choice || limited) && mode() === "always" && inside.length) {
    const chosen = await pickTargets({
      activity, plan: { ...plan, range: null, maxCount: plan.count },
      pool: inside, caster, preselect: limited ? ids.slice(0, plan.count) : ids
    });
    // The spell is already cast - a closed picker means "keep what the area caught",
    // still capped at what the area may affect.
    ids = chosen ?? (limited ? ids.slice(0, plan.count) : ids);
  } else if (limited) ids = ids.slice(0, plan.count);

  setTargets(ids);
  await refreshCardTargets(results.message);
  // An aura that buffs whoever stands in it (Aura of Protection, type "ally").
  await applyToTargets(activity, results);
}

/**
 * The usage card was created before the template existed, so its "Targeted" list -
 * the one dnd5e's save and damage application reads (TargetedApplicationMixin) - is
 * empty. Re-snapshot it now that the area has filled the targets.
 */
async function refreshCardTargets(message) {
  const describe = globalThis.dnd5e?.utils?.getTargetDescriptors;
  if (!message?.isOwner || typeof describe !== "function") return;
  try {
    await message.setFlag("dnd5e", "targets", describe());
  } catch (err) {
    console.warn(`${MODULE_ID} | could not update the usage card's targets`, err);
  }
}

function reportOvercount(activity, plan, results) {
  const level = results.message?.system?.spellLevel;
  if (!level || plan.maxCount === plan.count) return;
  const allowed = countAtLevel(activity, level) ?? plan.count;
  if (plan.chosen.length <= allowed) return;
  ui.notifications.warn(game.i18n.format(`${MODULE_ID}.targets.overcount`, {
    name: activity.item?.name ?? activity.name, count: plan.chosen.length, allowed, level
  }));
}

/**
 * Whether any grid space of the token lies inside a placed template - the same test
 * Foundry's own grid highlight uses, so what lights up is what gets targeted.
 */
function insideTemplate(token, doc) {
  const shape = templateShape(doc);
  if (!shape) return false;
  return spaceCenters(token).some(p => shape.contains(p.x - doc.x, p.y - doc.y));
}

function templateShape(doc) {
  const object = doc.object;
  // The object may not be drawn yet when use() returns; _computeShape only reads the
  // document, so it is right either way.
  if (typeof object?._computeShape === "function") return object._computeShape();
  if (object?.shape) return object.shape;
  const MT = foundry.canvas.placeables.MeasuredTemplate;
  const px = canvas.dimensions.distancePixels;
  const distance = doc.distance * px;
  const direction = Math.toRadians(doc.direction);
  switch (doc.t) {
    case "circle": return MT.getCircleShape(distance);
    case "cone": return MT.getConeShape(distance, direction, doc.angle);
    case "rect": return MT.getRectShape(distance, direction);
    case "ray": return MT.getRayShape(distance, direction, doc.width * px);
  }
  return null;
}

/* -------------------------------------------- */
/*  The picker                                   */
/* -------------------------------------------- */

/**
 * A list of the tokens the activity may aim at, nearest first, out-of-range ones
 * below a divider. Ticking a row targets that token on the canvas immediately, so the
 * reticles show what will be hit before anything is rolled. Resolves to the chosen
 * token ids, [] for "without a target", or null for cancel - in which case the
 * targets go back to what they were.
 */
async function pickTargets({ activity, plan, pool, caster, preselect }) {
  const esc = Handlebars.escapeExpression;
  const t = (key, data) => esc(data ? game.i18n.format(`${MODULE_ID}.targets.${key}`, data)
    : game.i18n.localize(`${MODULE_ID}.targets.${key}`));
  const before = currentTargetIds();
  const limit = plan.maxCount ?? plan.count;
  const selected = new Set(preselect);
  const units = canvas.scene?.grid?.units ?? "";

  const row = ({ token, distance }) => {
    const out = plan.range != null && distance != null && distance > plan.range;
    const D = CONST.TOKEN_DISPOSITIONS;
    const disposition = { [D.FRIENDLY]: "friendly", [D.NEUTRAL]: "neutral", [D.HOSTILE]: "hostile" }[token.document.disposition] ?? "secret";
    const dist = distance == null ? "" : `${Math.round(distance * 10) / 10} ${esc(units)}`;
    return `<li class="hudtra-target ${disposition}${out ? " out" : ""}" data-id="${token.id}">
      <label>
        <input type="checkbox" value="${token.id}"${selected.has(token.id) ? " checked" : ""}>
        <img src="${esc(token.document.texture.src)}" alt="">
        <span class="name">${esc(token.document.name)}${token === caster ? ` <em>${t("you")}</em>` : ""}</span>
        <span class="dist">${dist}</span>
      </label>
    </li>`;
  };
  const inRange = pool.filter(c => plan.range == null || c.distance == null || c.distance <= plan.range);
  const outOfRange = pool.filter(c => !inRange.includes(c));
  const header = [activity.labels?.target, activity.labels?.range].filter(Boolean).map(esc).join(" · ");
  const content = `<div class="hudtra-targets-body">
      ${header ? `<p class="hudtra-targets-what">${header}</p>` : ""}
      <p class="hudtra-targets-count"></p>
      ${pool.length ? "" : `<p class="hint">${t("none")}</p>`}
      <ul class="hudtra-target-list">${inRange.map(row).join("")}</ul>
      ${outOfRange.length ? `<p class="hudtra-targets-divider">${t(plan.soft ? "beyondTouch" : "outOfRange")}</p>
        <ul class="hudtra-target-list">${outOfRange.map(row).join("")}</ul>` : ""}
    </div>`;

  const result = await DialogV2.wait({
    window: { title: game.i18n.format(`${MODULE_ID}.targets.title`, { name: activity.item?.name ?? activity.name }) },
    classes: ["hudtra-targets"],
    position: { width: 360 },
    content,
    buttons: [
      { action: "confirm", label: t("confirm"), icon: "fa-solid fa-crosshairs", default: true,
        callback: () => [...selected] },
      { action: "skip", label: t("skip"), icon: "fa-solid fa-ban", callback: () => [] },
      { action: "cancel", label: t("cancel"), icon: "fa-solid fa-xmark", callback: () => null }
    ],
    render: (event, dialog) => wirePicker(dialog.element, { selected, limit, plan, t }),
    rejectClose: false
  }).catch(() => null);

  if (result === null || result === undefined) {
    setTargets(before);
    return null;
  }
  return result;
}

function wirePicker(root, { selected, limit, plan, t }) {
  const boxes = [...root.querySelectorAll(".hudtra-target input")];
  const counter = root.querySelector(".hudtra-targets-count");
  const sync = () => {
    for (const box of boxes) {
      box.checked = selected.has(box.value);
      // At the limit the remaining rows lock - except with a single target, where a
      // click on another row simply moves the selection there (see below).
      box.disabled = !!limit && limit > 1 && !box.checked && selected.size >= limit;
      box.closest(".hudtra-target")?.classList.toggle("selected", box.checked);
    }
    const max = limit ?? "∞";
    counter.textContent = plan.maxCount && plan.maxCount !== plan.count
      ? t("countUpcast", { n: selected.size, max, base: plan.count })
      : t("count", { n: selected.size, max });
    setTargets([...selected]);
  };
  root.addEventListener("change", (event) => {
    const box = event.target.closest?.(".hudtra-target input");
    if (!box) return;
    if (box.checked) {
      if (limit === 1) selected.clear();
      selected.add(box.value);
    } else selected.delete(box.value);
    sync();
  });
  // Double-click picks exactly that one and confirms - the fast path for the
  // single-target attack, which is most of what anybody clicks in combat.
  root.addEventListener("dblclick", (event) => {
    const li = event.target.closest?.(".hudtra-target");
    if (!li || limit !== 1) return;
    selected.clear();
    selected.add(li.dataset.id);
    sync();
    root.querySelector('button[data-action="confirm"]')?.click();
  });
  // Hovering a row lights its token on the canvas, so two goblins of the same name
  // can be told apart.
  root.addEventListener("pointerover", (event) => hoverToken(event, true));
  root.addEventListener("pointerout", (event) => hoverToken(event, false));
  sync();
}

function hoverToken(event, on) {
  const li = event.target.closest?.(".hudtra-target");
  if (!li || li.contains(event.relatedTarget)) return;
  const token = canvas.tokens?.get(li.dataset.id);
  if (!token) return;
  try {
    if (on) token._onHoverIn?.(event, { hoverOutOthers: true });
    else token._onHoverOut?.(event);
  } catch {
    // Purely cosmetic; a core change to the hover signature must not break picking.
  }
}

/* -------------------------------------------- */
/*  Uses that do not start on the bar            */
/* -------------------------------------------- */

/**
 * Marks a usage this module has already aimed, so the interceptor lets it through.
 * A plain key rather than a dotted one: usage configs go through mergeObject, which
 * would expand "a.b" into a nested object.
 */
export const AIMED = "hudtraAimed";

/**
 * dnd5e.preUseActivity, registered before every other handler of this module: the
 * ONE place a use gets aimed, whether the click was on the bar or on the character
 * sheet - the bar calls use() exactly as the sheet does, so the two cannot diverge.
 *
 * The hook cannot wait for a picker, so the usage is stopped here and started again
 * once the targets are settled - with the same configuration and the AIMED mark.
 * Left alone: uses without a click (macros, other modules' automation), uses caused
 * by another activity, shift-clicks, and everything while Midi QoL runs the show.
 */
export function interceptUse(activity, usageConfig, dialogConfig, messageConfig) {
  if (usageConfig?.[AIMED] || !usageConfig?.event || usageConfig.cause) return true;
  if (mode() === "off" || !canvas?.ready || game.modules.get("midi-qol")?.active) return true;
  if (usageConfig.event.shiftKey) return true;
  if (targetPlan(activity).kind === "none") return true;
  // The hook hands over a working clone; start again from the item on the actor.
  const original = activity.actor?.items.get(activity.item.id)?.system.activities?.get(activity.id);
  if (!original) return true;
  aimAndUse(original, usageConfig, dialogConfig, messageConfig);
  return false;
}

async function aimAndUse(activity, usageConfig, dialogConfig, messageConfig) {
  try {
    const plan = await beforeUse(activity, usageConfig.event);
    if (plan === false) return;
    const message = foundry.utils.deepClone(messageConfig ?? {});
    // Snapshotted before the targets were settled; dropped so use() takes a fresh one.
    delete message.data?.flags?.dnd5e?.targets;
    const results = await activity.use({ ...usageConfig, [AIMED]: true }, dialogConfig, message);
    await afterUse(activity, plan, results);
  } catch (err) {
    console.error(`${MODULE_ID} | aiming ${activity.name} failed`, err);
  }
}
