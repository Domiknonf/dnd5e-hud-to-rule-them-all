import { MODULE_ID } from "./const.mjs";
import { WILD_MAGIC_TABLE } from "./wild-magic-table.mjs";
import { playSurgeAnimation } from "./wild-magic-animations.mjs";
import { requestFromGM } from "./socket.mjs";
import { getActorConfig } from "./config.mjs";
import { combatantFor, grant, isTracked } from "./economy.mjs";

/**
 * WILD MAGIC SURGES.
 *
 * 1. A wild mage (see isWildMage) casts a spell of 1st level or higher.
 * 2. The surge check (setting `wildMagicTrigger`) decides whether it surges.
 * 3. surge() rolls the d100, rolls whatever the entry needs (1d10 inches, 5d10+20
 *    temporary HP, a coin), picks the random creatures, plays the animation and posts
 *    one chat card that says all of it - with the caster's spell save DC on it, since
 *    a surge that casts a spell or calls for a save uses the triggering caster's.
 * 4. What only touches the caster (an effect, healing, mana, coins) is applied right
 *    away if `wildMagicAutoApply` is on. Everything that reaches other creatures, or
 *    needs a decision (cast Fireball where, roll damage on whom), is a button on the
 *    card. A button that writes to creatures its user does not own is run by the GM.
 *
 * Everything a button does is rebuilt from the card's flags and the table, so the GM
 * relay never takes effect data from a player - only "run part X of message Y".
 */

const FLAG = "surge";
const ICON = "icons/svg/aura.svg";

/* ------------------------------------------------------------------ */
/*  Who surges                                                         */
/* ------------------------------------------------------------------ */

/** Feature names that make a creature a wild mage on their own. */
const WILD_NAMES = /wild magic/i;

export function detectWildMage(actor) {
  if (!actor?.items) return null;
  return actor.items.find(i => WILD_NAMES.test(i.name ?? "")
    || i.system?.identifier === "wild-magic" || i.system?.identifier === "wild-magic-surge") ?? null;
}

/** The gear dialog's answer wins; "auto" asks the sheet. */
export function isWildMage(actor) {
  const setting = getActorConfig(actor).wildMagic;
  if (setting === "on") return true;
  if (setting === "off") return false;
  return !!detectWildMage(actor);
}

export const isSurgeSpell = (item) => !!item?.flags?.[MODULE_ID]?.surgeSpell;

/* ------------------------------------------------------------------ */
/*  The check after a cast                                             */
/* ------------------------------------------------------------------ */

/**
 * dnd5e.postUseActivity. Runs on the client that cast the spell, which is the one
 * that knows the targets.
 */
export async function onSpellCast(activity, usageConfig, results) {
  try {
    const mode = game.settings.get(MODULE_ID, "wildMagicTrigger");
    if (mode === "off" || mode === "manual") return;
    const item = activity?.item;
    const actor = activity?.actor;
    if (!results || !actor || item?.type !== "spell" || isSurgeSpell(item)) return;
    if (!(Number(item.system?.level) > 0)) return;
    if (!isWildMage(actor)) return;
    if (game.settings.get(MODULE_ID, "wildMagicSorcererOnly")) {
      const source = item.system?.sourceClass;
      if (source && source !== "sorcerer") return;
    }
    await check(actor, { spell: item.name });
  } catch (err) {
    console.error(`${MODULE_ID} | wild magic check failed`, err);
  }
}

/**
 * Roll the surge check. 2014: a d20, surge on a 1. 2024: a d20, surge on a 20.
 * "always": every leveled spell surges. Returns the surge message, or null.
 */
export async function check(actor, { spell = "" } = {}) {
  const mode = game.settings.get(MODULE_ID, "wildMagicTrigger");
  if (mode === "always") return surge(actor, { spell });
  const roll = await new Roll("1d20").evaluate();
  const hit = mode === "d20high" ? roll.total === 20 : roll.total === 1;
  const flavor = game.i18n.format(`${MODULE_ID}.wildMagic.check`, {
    name: actor.name, spell: spell || "—", result: game.i18n.localize(`${MODULE_ID}.wildMagic.${hit ? "surges" : "calm"}`)
  });
  await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor },
    { rollMode: hit ? rollMode() : "gmroll" });
  return hit ? surge(actor, { spell }) : null;
}

const rollMode = () => (game.settings.get(MODULE_ID, "wildMagicRollMode") === "gm" ? "gmroll" : "publicroll");

/* ------------------------------------------------------------------ */
/*  The surge                                                          */
/* ------------------------------------------------------------------ */

/**
 * Roll on the table and post the card.
 * @param {Actor} actor
 * @param {object} [options]
 * @param {number} [options.number]   force an entry (1-100) instead of rolling
 * @param {string} [options.spell]    the spell that caused it, for the card
 * @param {Token[]} [options.targets] defaults to this user's targets
 */
export async function surge(actor, { number = null, spell = "", targets = null } = {}) {
  if (!actor) return null;
  const d100 = await new Roll("1d100").evaluate();
  const n = Number.isInteger(number) && number >= 1 && number <= 100 ? number : d100.total;
  const entry = WILD_MAGIC_TABLE[n];

  const casterToken = speakerToken(actor);
  const targetDocs = [...(targets ?? game.user.targets)]
    .map(t => t.document ?? t).filter(t => t?.actor && t.actor !== actor);
  const targetToken = targetDocs[0] ?? null;

  // Every die the entry needs, rolled now: the card states results, not formulas.
  const rolls = [d100];
  const values = {};
  for (const [key, formula] of Object.entries(entry.rolls ?? {})) {
    const r = await new Roll(formula).evaluate();
    rolls.push(r);
    values[key] = r.total;
  }
  for (const [key, list] of Object.entries(entry.pick ?? {})) values[key] = pickOne(list);
  Object.assign(values, entry.derive?.(values) ?? {});

  // Random creatures are picked here, once, so the card names them and the GM relay
  // applies the effect to exactly the creatures the card shows.
  const pickedTokens = recipientsFor(entry, casterToken, targetToken);
  if (entry.effect?.on === "randomAlly") values.ally = pickedTokens.find(t => t.actor !== actor)?.name ?? "nobody in range";
  if (entry.effect?.on === "randomNear") values.victim = pickedTokens[0]?.name ?? "nobody in range";
  if (entry.randomFlier) {
    const pool = tokensWithin(casterToken, entry.randomFlier, { includeCenter: true });
    values.flier = pickOne(pool)?.name ?? actor.name;
  }
  if (entry.mana === "sorcererLevel") values.mana = sorcererLevel(actor);

  const caster = spellcasting(actor);
  const data = {
    number: n,
    rolled: number ? null : d100.total,
    spell,
    values,
    casterUuid: actor.uuid,
    casterTokenUuid: casterToken?.uuid ?? null,
    targetUuids: targetDocs.map(t => t.uuid),
    recipients: pickedTokens.map(t => t.uuid),
    caster,
    applied: {}
  };

  const message = await ChatMessage.implementation.create(ChatMessage.applyRollMode({
    speaker: ChatMessage.getSpeaker({ actor, token: casterToken }),
    content: renderCard(entry, data, actor, targetToken),
    rolls,
    sound: CONFIG.sounds.dice,
    flags: { [MODULE_ID]: { [FLAG]: data } }
  }, rollMode()));

  playSurgeAnimation(n, { casterToken, targetToken });
  if (game.settings.get(MODULE_ID, "wildMagicAutoApply")) await autoApply(message, entry);
  return message;
}

const pickOne = (list) => (list?.length ? list[Math.floor(Math.random() * list.length)] : null);

/** The caster's spellcasting numbers, as the card prints them. */
function spellcasting(actor) {
  const ability = actor.system?.attributes?.spellcasting || "int";
  return {
    ability,
    abilityLabel: CONFIG.DND5E?.abilities?.[ability]?.label ?? ability.toUpperCase(),
    dc: actor.system?.attributes?.spell?.dc ?? (8 + (actor.system?.attributes?.prof ?? 2) + (actor.system?.abilities?.[ability]?.mod ?? 0)),
    mod: actor.system?.abilities?.[ability]?.mod ?? 0
  };
}

function sorcererLevel(actor) {
  return Number(actor.classes?.sorcerer?.system?.levels
    ?? actor.items.find(i => i.type === "class" && i.system?.identifier === "sorcerer")?.system?.levels ?? 0);
}

/* ------------------------------------------------------------------ */
/*  Tokens and distances                                               */
/* ------------------------------------------------------------------ */

function speakerToken(actor) {
  const controlled = canvas?.tokens?.controlled?.find(t => t.actor === actor);
  return (controlled ?? actor.getActiveTokens?.()[0])?.document ?? null;
}

function distance(a, b) {
  try {
    return canvas.grid.measurePath([a.object.center, b.object.center]).distance;
  } catch {
    return Infinity;
  }
}

/** Token documents within `radius` ft of `center`, nearest first. */
function tokensWithin(center, radius, { includeCenter = false } = {}) {
  if (!center?.object || !canvas?.ready) return [];
  return canvas.tokens.placeables
    .map(t => t.document)
    .filter(t => t.actor && (includeCenter || t !== center) && !t.hidden)
    .map(t => ({ t, d: t === center ? 0 : distance(center, t) }))
    .filter(({ d }) => d <= radius)
    .sort((a, b) => a.d - b.d)
    .map(({ t }) => t);
}

/** Who an entry's effect lands on, as token documents. */
function recipientsFor(entry, casterToken, targetToken) {
  const spec = entry.effect;
  if (!spec) return [];
  switch (spec.on) {
    case "area": {
      const center = spec.center === "target" ? targetToken : casterToken;
      return tokensWithin(center, spec.radius, { includeCenter: spec.includeCenter });
    }
    case "randomAlly": {
      const allies = tokensWithin(casterToken, spec.radius)
        .filter(t => t.disposition === casterToken?.disposition && t.actor !== casterToken?.actor);
      return [casterToken, pickOne(allies)].filter(Boolean);
    }
    case "randomNear":
      return [pickOne(tokensWithin(targetToken ?? casterToken, spec.radius))].filter(Boolean);
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ */
/*  The card                                                           */
/* ------------------------------------------------------------------ */

const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");
const loc = (key, data) => (data ? game.i18n.format(`${MODULE_ID}.wildMagic.${key}`, data) : game.i18n.localize(`${MODULE_ID}.wildMagic.${key}`));

function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (m, key) => (values[key] !== undefined ? `<strong>${esc(values[key])}</strong>` : m));
}

/** The buttons an entry gets, in card order. */
function partsOf(entry) {
  const parts = [];
  if (entry.spell) parts.push("spell");
  if (entry.effect) parts.push("effect");
  if (entry.heal) parts.push("heal");
  if (entry.mana) parts.push("mana");
  if (entry.coins) parts.push("coins");
  if (entry.cycleCurrency) parts.push("cycle");
  if (entry.grant) parts.push("grant");
  if (entry.save) parts.push("save");
  if (entry.damage) parts.push("damage");
  return parts;
}

const PART_ICONS = {
  spell: "fa-wand-sparkles", effect: "fa-person-rays", heal: "fa-heart", mana: "fa-droplet",
  coins: "fa-coins", cycle: "fa-arrows-rotate", grant: "fa-hand-fist", save: "fa-shield-halved",
  damage: "fa-burst"
};

function partLabel(part, entry, data) {
  const v = data.values;
  switch (part) {
    case "spell": return loc("button.spell", { spell: entry.spell.name });
    case "effect": return loc(`button.effect.${entry.effect.on}`, { name: entry.effect.name });
    case "heal": return loc("button.heal", { hp: v[entry.heal] });
    case "mana": return loc("button.mana", { amount: manaDelta(entry, data) });
    case "coins": return loc("button.coins", { amount: v[entry.coins.sp] });
    case "save": return loc("button.save", { dc: entry.save.dc, ability: entry.save.ability.toUpperCase() });
    case "damage": return loc("button.damage", { formula: entry.damage.formula.replace("@mod", data.caster.mod), type: entry.damage.type });
    default: return loc(`button.${part}`);
  }
}

function renderCard(entry, data, actor, targetToken) {
  const recipients = data.recipients
    .map(u => fromUuidSync(u)?.name).filter(Boolean);
  const head = loc("card.title", { number: data.number });
  const cause = data.spell ? `<p class="hudtra-wm-cause">${esc(loc("card.cause", { name: actor.name, spell: data.spell }))}</p>` : "";
  const target = targetToken ? `<span>${esc(loc("card.target", { name: targetToken.name }))}</span>` : `<span>${esc(loc("card.noTarget"))}</span>`;
  const save = entry.damage?.save
    ? `<p class="hudtra-wm-save">${esc(loc("card.saveHalf", { dc: data.caster.dc, ability: CONFIG.DND5E?.abilities?.[entry.damage.save]?.label ?? entry.damage.save }))}</p>`
    : "";
  const who = recipients.length && entry.effect?.on === "area"
    ? `<p class="hudtra-wm-who">${esc(loc("card.affected", { names: recipients.join(", ") }))}</p>` : "";
  const buttons = partsOf(entry).map(part => `
    <button type="button" data-wm-part="${part}">
      <i class="fa-solid ${PART_ICONS[part]}"></i> <span>${esc(partLabel(part, entry, data))}</span>
    </button>`).join("");

  return `
  <div class="hudtra-wm-card">
    <header class="hudtra-wm-head">
      <span class="hudtra-wm-number">${data.number}</span>
      <h3>${esc(head)}</h3>
    </header>
    ${cause}
    <p class="hudtra-wm-text">${fill(esc(entry.text), data.values)}</p>
    ${who}${save}
    <p class="hudtra-wm-meta">
      <span>${esc(loc("card.dc", { dc: data.caster.dc, ability: data.caster.abilityLabel }))}</span>
      ${target}
    </p>
    ${buttons ? `<div class="hudtra-wm-buttons">${buttons}</div>` : ""}
  </div>`;
}

/**
 * renderChatMessageHTML: wire the buttons, hide the ones this user may not press,
 * and grey out what has already been done.
 */
export function onRenderMessage(message, html) {
  const data = message.flags?.[MODULE_ID]?.[FLAG];
  if (!data) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  const caster = fromUuidSync(data.casterUuid);
  const allowed = game.user.isGM || !!caster?.isOwner;
  for (const button of root.querySelectorAll("[data-wm-part]")) {
    const part = button.dataset.wmPart;
    if (!allowed) { button.remove(); continue; }
    if (data.applied?.[part]) {
      button.classList.add("done");
      button.querySelector("i")?.classList.replace(PART_ICONS[part], "fa-check");
    }
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      button.disabled = true;
      try { await runPart(message, part); } finally { button.disabled = false; }
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Running a part                                                     */
/* ------------------------------------------------------------------ */

/** Parts that only touch the caster and need no decision. */
const AUTO_PARTS = new Set(["heal", "mana", "coins", "cycle", "grant"]);

async function autoApply(message, entry) {
  for (const part of partsOf(entry)) {
    if (AUTO_PARTS.has(part) || (part === "effect" && entry.effect.on === "caster")) {
      await runPart(message, part);
    }
  }
}

/** Parts the caster's owner performs on their own client, whatever they touch. */
const LOCAL_PARTS = new Set(["spell", "save", "damage"]);

export async function runPart(message, part) {
  const data = message.flags?.[MODULE_ID]?.[FLAG];
  const entry = WILD_MAGIC_TABLE[data?.number];
  if (!entry) return;
  const caster = await fromUuid(data.casterUuid);
  if (!caster) return;

  if (!LOCAL_PARTS.has(part) && !game.user.isGM) {
    const actors = await actorsForPart(entry, data, part, caster);
    if (actors.some(a => !a.isOwner)) {
      if (requestFromGM("wildMagic", { messageId: message.id, part })) {
        ui.notifications.info(loc("delegated"));
      }
      return;
    }
  }
  await performPart(message, part);
}

/** Socket side: the active GM runs what a player could not. */
export async function handleRequest({ messageId, part } = {}) {
  const message = game.messages.get(messageId);
  if (!message?.flags?.[MODULE_ID]?.[FLAG] || LOCAL_PARTS.has(part)) return;
  return performPart(message, part);
}

async function performPart(message, part) {
  const data = message.flags[MODULE_ID][FLAG];
  const entry = WILD_MAGIC_TABLE[data.number];
  const caster = await fromUuid(data.casterUuid);
  if (!entry || !caster) return;
  try {
    let done = true;
    switch (part) {
      case "effect": done = await applyEffects(entry, data, caster); break;
      case "heal": await heal(caster, data.values[entry.heal]); break;
      case "mana": done = await changeMana(caster, manaDelta(entry, data)); break;
      case "coins": await addCoins(caster, entry.coins, data.values); break;
      case "cycle": await cycleCurrency(caster); break;
      case "grant": done = await grantAction(caster, entry.grant); break;
      case "save": await rollSave(caster, entry.save); break;
      case "damage": await rollDamage(caster, entry, data); break;
      case "spell": done = await castSpell(caster, entry.spell, data); break;
    }
    if (done && message.isOwner) await message.setFlag(MODULE_ID, `${FLAG}.applied.${part}`, true);
  } catch (err) {
    console.error(`${MODULE_ID} | wild magic part "${part}" failed`, err);
    ui.notifications.error(loc("failed", { part }));
  }
}

async function actorsForPart(entry, data, part, caster) {
  if (part !== "effect") return [caster];
  return (await recipientTokens(entry, data, caster)).map(t => t.actor ?? t).filter(Boolean);
}

/** Tokens (or, without one, the actor) an effect lands on. */
async function recipientTokens(entry, data, caster) {
  const resolveAll = async (uuids) => (await Promise.all((uuids ?? []).map(u => fromUuid(u)))).filter(Boolean);
  const casterDoc = (await fromUuid(data.casterTokenUuid ?? "")) ?? caster;
  const [target] = await resolveAll(data.targetUuids);
  switch (entry.effect.on) {
    case "caster": return [casterDoc];
    case "target": return target ? [target] : [];
    case "both": return [casterDoc, target].filter(Boolean);
    case "coin": return data.values.who === "caster" ? [casterDoc] : (target ? [target] : []);
    default: return resolveAll(data.recipients);
  }
}

/* ------------------------------------------------------------------ */
/*  Effects                                                            */
/* ------------------------------------------------------------------ */

function effectData(entry, data, caster, actor) {
  const spec = entry.effect;
  const changes = [...(spec.changes ?? [])];
  if (spec.spellcastingPenalty) {
    changes.push({ key: `system.abilities.${data.caster.ability}.value`, mode: 2, value: String(-spec.spellcastingPenalty) });
  }
  if (spec.swapAbilities) {
    const [a, b] = spec.swapAbilities;
    const abilities = actor.system?.abilities ?? {};
    changes.push({ key: `system.abilities.${a}.value`, mode: 5, value: String(abilities[b]?.value ?? 10) });
    changes.push({ key: `system.abilities.${b}.value`, mode: 5, value: String(abilities[a]?.value ?? 10) });
  }
  if (spec.resistAll) {
    for (const type of Object.keys(CONFIG.DND5E?.damageTypes ?? {})) {
      changes.push({ key: "system.traits.dr.value", mode: 2, value: type });
    }
  }

  let seconds = spec.seconds;
  for (const [key, per] of Object.entries(spec.secondsPer ?? {})) seconds = Number(data.values[key] ?? 1) * per;
  const combat = game.combat?.started ? game.combat : null;
  const duration = { startTime: game.time.worldTime };
  if (combat && spec.rounds) {
    Object.assign(duration, {
      rounds: spec.rounds, turns: spec.turns ?? 0,
      combat: combat.id, startRound: combat.round, startTurn: combat.turn
    });
  } else if (seconds) duration.seconds = seconds;

  return {
    name: loc("effectName", { name: spec.name }),
    img: ICON,
    description: fill(esc(entry.text), data.values),
    origin: caster.uuid,
    duration,
    changes,
    statuses: spec.statuses ?? [],
    flags: { [MODULE_ID]: { surge: data.number, recurring: spec.recurring ?? null } }
  };
}

async function applyEffects(entry, data, caster) {
  const tokens = await recipientTokens(entry, data, caster);
  if (!tokens.length) { ui.notifications.warn(loc("noRecipients")); return false; }
  for (const doc of tokens) {
    const actor = doc.actor ?? doc;
    if (!actor) continue;
    await ActiveEffect.implementation.create(effectData(entry, data, caster, actor), { parent: actor });
    if (entry.tempHp) await giveTempHp(actor, data.values[entry.tempHp]);
  }
  return true;
}

/* ------------------------------------------------------------------ */
/*  Hit points, mana, money, the economy                               */
/* ------------------------------------------------------------------ */

async function heal(actor, amount) {
  const hp = actor.system?.attributes?.hp;
  if (!hp || !(amount > 0)) return;
  const max = hp.effectiveMax ?? hp.max ?? hp.value;
  await actor.update({ "system.attributes.hp.value": Math.min(max, (hp.value ?? 0) + amount) });
}

async function giveTempHp(actor, amount) {
  const hp = actor.system?.attributes?.hp;
  if (!hp || !(amount > 0)) return;
  if ((hp.temp ?? 0) >= amount) return;
  await actor.update({ "system.attributes.hp.temp": amount });
}

function manaDelta(entry, data) {
  if (entry.mana === "sorcererLevel") return Number(data.values.mana ?? 0);
  if (typeof entry.mana === "string" && entry.mana.startsWith("-")) return -Number(data.values[entry.mana.slice(1)] ?? 0);
  return Number(data.values[entry.mana] ?? 0);
}

/**
 * Where this actor keeps its mana. The setting names an attribute path
 * (`system.resources.primary`, or a `.value` path); without one, a resource labelled
 * Mana / Spell Points, then an item of that name with uses.
 */
function findMana(actor) {
  const path = game.settings.get(MODULE_ID, "wildMagicMana")?.trim();
  const get = foundry.utils.getProperty;
  if (path) {
    const at = get(actor, path);
    if (at && typeof at === "object" && "value" in at) return { kind: "path", path: `${path}.value`, value: Number(at.value) || 0, max: Number(at.max) || null };
    if (Number.isFinite(Number(at))) return { kind: "path", path, value: Number(at), max: null };
  }
  const NAMES = /^(mana|mana points|spell points)$/i;
  for (const [key, res] of Object.entries(actor.system?.resources ?? {})) {
    if (NAMES.test(res?.label ?? "")) return { kind: "path", path: `system.resources.${key}.value`, value: Number(res.value) || 0, max: Number(res.max) || null };
  }
  const item = actor.items.find(i => NAMES.test(i.name ?? "") && i.system?.uses?.max);
  if (item) {
    const uses = item.system.uses;
    const max = Number(uses.max) || 0;
    return { kind: "item", item, value: Number(uses.value ?? (max - (uses.spent ?? 0))), max };
  }
  return null;
}

async function changeMana(actor, delta) {
  const mana = findMana(actor);
  if (!mana) { ui.notifications.warn(loc("noMana", { name: actor.name })); return false; }
  let next = Math.max(0, mana.value + delta);
  if (mana.max !== null) next = Math.min(mana.max, next);
  if (mana.kind === "item") await mana.item.update({ "system.uses.spent": mana.max - next });
  else await actor.update({ [mana.path]: next });
  return true;
}

async function addCoins(actor, coins, values) {
  const update = {};
  for (const [denom, key] of Object.entries(coins)) {
    update[`system.currency.${denom}`] = (Number(actor.system?.currency?.[denom]) || 0) + Number(values[key] ?? 0);
  }
  await actor.update(update);
}

async function cycleCurrency(actor) {
  const c = actor.system?.currency ?? {};
  await actor.update({
    "system.currency.sp": Number(c.cp) || 0,
    "system.currency.gp": Number(c.sp) || 0,
    "system.currency.cp": Number(c.gp) || 0
  });
}

async function grantAction(actor, grants) {
  if (!game.combat?.started || !isTracked(actor)) return false;
  const combatant = combatantFor(actor);
  if (!combatant) return false;
  return grant(combatant, grants, { label: loc("title") });
}

/* ------------------------------------------------------------------ */
/*  Saves and damage                                                   */
/* ------------------------------------------------------------------ */

async function rollSave(actor, { ability, dc }) {
  let result;
  if (typeof actor.rollSavingThrow === "function") {
    result = await actor.rollSavingThrow({ ability, target: dc });
  } else {
    result = await actor.rollAbilitySave?.(ability, { targetValue: dc });
  }
  const roll = Array.isArray(result) ? result[0] : result;
  if (roll && roll.total < dc) {
    await ActiveEffect.implementation.create({
      name: loc("effectName", { name: loc("nosebleed") }),
      img: ICON,
      description: loc("nosebleedHint", { dc }),
      origin: actor.uuid,
      flags: { [MODULE_ID]: { surge: 68 } }
    }, { parent: actor });
  }
}

async function rollDamage(actor, entry, data) {
  const { formula, type, save } = entry.damage;
  const rollData = { ...(actor.getRollData?.() ?? {}), mod: data.caster.mod };
  const DamageRoll = CONFIG.Dice.DamageRoll ?? Roll;
  const roll = new DamageRoll(formula, rollData, { type });
  await roll.evaluate();
  const typeLabel = CONFIG.DND5E?.damageTypes?.[type]?.label ?? type;
  const flavor = save
    ? loc("damageSave", { type: typeLabel, dc: data.caster.dc, ability: CONFIG.DND5E?.abilities?.[save]?.label ?? save })
    : loc("damageFlavor", { type: typeLabel });
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `${loc("title")} ${data.number}: ${flavor}`,
    flags: { dnd5e: { roll: { type: "damage" } } }
  });
}

/* ------------------------------------------------------------------ */
/*  Spells                                                             */
/* ------------------------------------------------------------------ */

/** Find a spell by name: world items first, then the 2024 books, then everything. */
async function findSpell(names) {
  const wanted = names.map(n => n.toLowerCase());
  const match = (n) => wanted.includes(String(n ?? "").toLowerCase());
  const world = game.items.find(i => i.type === "spell" && match(i.name));
  if (world) return world.toObject();
  const packs = game.packs.filter(p => p.documentName === "Item")
    .sort((a, b) => rank(a) - rank(b));
  for (const pack of packs) {
    const index = await pack.getIndex({ fields: ["type"] });
    const hit = index.find(e => e.type === "spell" && match(e.name));
    if (hit) return (await pack.getDocument(hit._id))?.toObject() ?? null;
  }
  return null;
}

function rank(pack) {
  const id = pack.collection;
  if (/players-handbook/i.test(id)) return 0;
  if (pack.metadata.packageType === "world") return 1;
  if (id.startsWith("dnd5e.")) return 2;
  return 3;
}

/**
 * Cast the spell the surge calls for, with the caster's spellcasting ability and no
 * slot. It goes on the actor as its own item - flagged, hidden from the bar, and
 * cleaned up at the next rest - because the chat card's save and damage buttons look
 * the item up, and concentration (Fly, Polymorph) points at it.
 */
async function castSpell(actor, spec, data) {
  if (!actor.isOwner) return false;
  const source = await findSpell([spec.name, ...(spec.alt ?? [])]);
  if (!source) { ui.notifications.warn(loc("noSpell", { spell: spec.name })); return false; }
  delete source._id;
  source.name = loc("spellName", { spell: source.name });
  foundry.utils.setProperty(source, `flags.${MODULE_ID}.surgeSpell`, data.number);
  foundry.utils.setProperty(source, "system.ability", data.caster.ability);
  foundry.utils.setProperty(source, "system.method", "atwill");
  foundry.utils.setProperty(source, "system.preparation", { mode: "atwill", prepared: true });
  if (spec.level) foundry.utils.setProperty(source, "system.level", spec.level);

  const [item] = await actor.createEmbeddedDocuments("Item", [source]);
  const activity = item?.system?.activities?.contents?.[0];
  if (!activity) return false;
  await activity.use({ consume: false }, { configure: false });
  return true;
}

/** dnd5e.restCompleted: surge spells are gone after a rest. */
export async function cleanupSurgeSpells(actor) {
  if (!actor?.isOwner) return;
  const ids = actor.items.filter(isSurgeSpell).map(i => i.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
}

/* ------------------------------------------------------------------ */
/*  Start of turn                                                      */
/* ------------------------------------------------------------------ */

function isActive(effect) {
  if (effect.disabled) return false;
  const remaining = effect.duration?.remaining;
  return !(typeof remaining === "number" && remaining <= 0);
}

/**
 * combatTurnChange, on the active GM: entry 1 rolls again, entry 15 heals 5. Both are
 * read off the effect the surge left, so deleting the effect stops them.
 */
export async function onTurnStart(combatant) {
  const actor = combatant?.actor;
  if (!actor || !game.user.isActiveGM) return;
  const recurring = actor.effects.filter(e => e.flags?.[MODULE_ID]?.recurring && isActive(e));
  for (const effect of recurring) {
    const kind = effect.flags[MODULE_ID].recurring;
    if (kind === "heal5") await heal(actor, 5);
    // A surge that rolls entry 1 again adds another minute - that is the table's joke,
    // not a loop: each one is its own effect, expiring on its own.
    if (kind === "surge") await surge(actor, { spell: effect.name, targets: [] });
  }
}
