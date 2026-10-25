import { MODULE_ID } from "./const.mjs";

/**
 * House rule: a costly material component does not have to be carried, its price
 * does. Casting Revivify needs 300 gp in the purse rather than a diamond in the
 * pack; a component the spell consumes is paid for, one it does not consume only
 * has to be affordable.
 *
 * dnd5e records material components and never enforces them, and the 2024
 * compendium leaves materials.cost at 0 on every spell - the price exists only in
 * the text ("a diamond worth 300+ GP, which the spell consumes"). So the text is
 * parsed, and a cost entered on the spell's own details tab wins over it: that is
 * the switch for homebrew text the parser gets wrong.
 */

const WORDS = {
  a: 1, an: 1, one: 1, pair: 2, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};

/** Copper pieces per coin, from dnd5e's own conversion table (coins per gold piece). */
function coinValues() {
  const currencies = CONFIG.DND5E?.currencies ?? {};
  const values = {};
  for (const [key, { conversion }] of Object.entries(currencies)) {
    if (conversion > 0) values[key] = Math.round(100 / conversion);
  }
  return Object.keys(values).length ? values : { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
}

/**
 * What a material component costs, in copper: { required, consumed }.
 * `required` is what has to be in the purse, `consumed` what leaves it.
 *
 * Each "worth N+ GP" in the text is one component. A component is consumed when
 * its own clause says so ("..., which the spell consumes, and four ivory strips")
 * or the text says "all of which the spell consumes"; text that never mentions
 * consumption falls back to the spell's Consumed checkbox. "worth 50+ GP each"
 * multiplies by the quantity the clause opens with ("a pair of platinum rings"),
 * "for each of the spell's targets" by the number of targets.
 */
export function materialCost(item, { targets = 1 } = {}) {
  const materials = item?.system?.materials;
  if (!materials || !item.system.properties?.has?.("material")) return null;
  const gp = coinValues().gp ?? 100;

  if (materials.cost > 0) {
    const cost = Math.round(materials.cost * gp);
    return { required: cost, consumed: materials.consumed ? cost : 0 };
  }

  const text = String(materials.value ?? "").replace(/’/g, "'");
  const values = coinValues();
  const mentionsConsume = /consum/i.test(text);
  const allConsumed = /all of which[^.]*consum/i.test(text);
  const perTarget = /for each (?:of the spell's )?targets?\b/i.test(text) ? Math.max(1, targets) : 1;

  let required = 0;
  let consumed = 0;
  // Split where a new component starts: ", and ..." or " and one/a/two ...".
  const clauses = text.split(/,\s*and\s+|\s+and\s+(?=(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten)\b)/i);
  for (const clause of clauses) {
    for (const m of clause.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*\+?\s*(pp|gp|ep|sp|cp)\b(\s+each)?/gi)) {
      const unit = values[m[2].toLowerCase()] ?? gp;
      let amount = Number(m[1].replace(/,/g, "")) * unit;
      if (m[3]) {
        const lead = clause.trim().match(/^(?:for each [^,]*,\s*)?(\w+)(?:\s+(pair)\b)?/i);
        amount *= lead?.[2] ? 2 : (WORDS[lead?.[1]?.toLowerCase()] ?? 1);
      }
      amount = Math.round(amount * perTarget);
      required += amount;
      const isConsumed = allConsumed || (mentionsConsume ? /consum/i.test(clause) : materials.consumed);
      if (isConsumed) consumed += amount;
    }
  }
  return required > 0 ? { required, consumed } : null;
}

/** The purse in copper. */
function wealth(actor) {
  const values = coinValues();
  const purse = actor?.system?.currency ?? {};
  return Object.entries(values).reduce((sum, [key, v]) => sum + (Number(purse[key]) || 0) * v, 0);
}

/**
 * Coins to take out of the purse to pay `cost` copper, as new currency values.
 * Gold first, then platinum, then the smaller coins; whatever is still owed after
 * that is smaller than every coin left, so one coin of the smallest remaining kind
 * pays it and the change comes back as gold, silver and copper. Returns null when
 * the purse is short.
 */
export function payment(actor, cost) {
  if (wealth(actor) < cost) return null;
  const values = coinValues();
  const purse = Object.fromEntries(Object.keys(values).map(k => [k, Number(actor.system.currency?.[k]) || 0]));
  const order = ["gp", "pp", "ep", "sp", "cp"].filter(k => k in values);
  let owed = cost;
  for (const key of order) {
    const take = Math.min(purse[key], Math.floor(owed / values[key]));
    purse[key] -= take;
    owed -= take * values[key];
  }
  if (owed > 0) {
    const coin = Object.keys(values).filter(k => purse[k] > 0).sort((a, b) => values[a] - values[b])[0];
    purse[coin] -= 1;
    let change = values[coin] - owed;
    for (const key of ["gp", "sp", "cp"].filter(k => k in values)) {
      const give = Math.floor(change / values[key]);
      purse[key] += give;
      change -= give * values[key];
    }
  }
  return purse;
}

/** "3 gp 5 sp" for a copper amount. */
export function formatCoins(copper) {
  const values = coinValues();
  const parts = [];
  let rest = copper;
  for (const key of ["gp", "sp", "cp"].filter(k => k in values)) {
    const n = Math.floor(rest / values[key]);
    if (n) parts.push(`${n.toLocaleString()} ${key}`);
    rest -= n * values[key];
  }
  return parts.join(" ") || `0 ${Object.keys(values).includes("gp") ? "gp" : "cp"}`;
}

/**
 * Whether this usage is a casting the rule applies to: a player character's own
 * spell, through an activity that is the casting itself. A spell's follow-up
 * activities (Hex's extra damage, Spiritual Weapon's attack) are marked as not
 * consuming a slot, and must not charge the diamond again. Spells cast from a
 * scroll, wand or other item (a cached copy, flagged cachedFor) need no
 * components, and 2024 monsters cast without material components altogether.
 */
export function appliesTo(activity) {
  if (!game.settings.get(MODULE_ID, "materialGold")) return false;
  const item = activity?.item;
  if (item?.type !== "spell" || activity.actor?.type !== "character") return false;
  if (item.getFlag?.("dnd5e", "cachedFor")) return false;
  if (activity.consumption?.spellSlot === false) return false;
  return true;
}

const targetCount = () => Math.max(1, game.user.targets?.size ?? 1);

/**
 * Gate, from dnd5e.preUseActivity: is the purse deep enough? Returns false to
 * cancel the casting. The GM is warned instead of blocked when the GM bypass
 * (the same setting the action economy uses) is on.
 */
export function checkMaterials(activity) {
  if (!appliesTo(activity)) return true;
  const cost = materialCost(activity.item, { targets: targetCount() });
  if (!cost || wealth(activity.actor) >= cost.required) return true;
  const msg = game.i18n.format(`${MODULE_ID}.materials.short`, {
    name: activity.item.name, cost: formatCoins(cost.required), have: formatCoins(wealth(activity.actor))
  });
  if (game.user.isGM && game.settings.get(MODULE_ID, "gmBypass")) {
    ui.notifications.info(msg);
    return true;
  }
  ui.notifications.warn(msg);
  return false;
}

/**
 * Payment, from dnd5e.activityConsumption: the coins go into the same update that
 * spends the slot. That makes the casting and the payment one write, and it puts
 * the gold into the deltas dnd5e stores on the chat card - so the card's refund
 * button gives the gold back along with the slot.
 */
export function payMaterials(activity, usageConfig, updates) {
  if (usageConfig?.consume === false || !appliesTo(activity)) return;
  const cost = materialCost(activity.item, { targets: targetCount() });
  if (!cost?.consumed) return;
  const purse = payment(activity.actor, cost.consumed);
  // The gate let it through (a GM bypass, or the purse changed in between): the
  // casting goes ahead and nothing is taken, rather than pushing coins negative.
  if (!purse) return;
  updates.actor ??= {};
  for (const [key, value] of Object.entries(purse)) {
    if (value !== (Number(activity.actor.system.currency?.[key]) || 0)) updates.actor[`system.currency.${key}`] = value;
  }
  ui.notifications.info(game.i18n.format(`${MODULE_ID}.materials.paid`, {
    name: activity.item.name, cost: formatCoins(cost.consumed)
  }));
}
