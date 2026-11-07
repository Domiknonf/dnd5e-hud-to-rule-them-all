import { MODULE_ID } from "../const.mjs";
import { featureOf, othersOnScene } from "./zero-hp.mjs";

/**
 * Dark One's Blessing (Fiend Patron, PHB 2024): when the warlock drops an enemy to
 * 0 HP - or anyone does it within 10 ft of the warlock - the warlock gains temporary
 * HP equal to CHA modifier + warlock level, minimum 1.
 *
 * No reaction, no use, no question: it simply happens, so it costs nothing in the
 * economy and asks nobody.
 */

const IDENTIFIER = "dark-ones-blessing";
const RANGE = 10;

/** Opposite sides only. NEUTRAL is nobody's enemy. */
function isEnemy(warlock, corpse) {
  const { FRIENDLY, HOSTILE, SECRET } = CONST.TOKEN_DISPOSITIONS;
  const hostile = d => d === HOSTILE || d === SECRET;
  return (warlock === FRIENDLY && hostile(corpse)) || (hostile(warlock) && corpse === FRIENDLY);
}

export async function darkOnesBlessing(event) {
  const { token: corpse, killerUuid } = event;
  for (const { token, actor, distance } of othersOnScene(event)) {
    const item = featureOf(actor, IDENTIFIER);
    if (!item) continue;
    if (!isEnemy(token.disposition, corpse.disposition)) continue;
    if (distance > RANGE && killerUuid !== actor.uuid) continue;
    await bless(actor, token, item, corpse.name);
  }
}

/**
 * The feature's own heal activity says how much, when it carries a temp-HP formula
 * that resolves to a fixed number; the rule text is the fallback.
 */
function blessingValue(actor, item) {
  const activity = item.system.activities?.find(a =>
    a.type === "heal" && new Set(a.healing?.types ?? []).has("temphp"));
  const formula = activity?.healing?.formula;
  const fromActivity = formula ? dnd5e.utils.simplifyBonus(formula, actor.getRollData()) : 0;
  if (fromActivity > 0) return fromActivity;
  const cha = actor.system?.abilities?.cha?.mod ?? 0;
  const levels = actor.classes?.warlock?.system?.levels ?? 0;
  return Math.max(1, cha + levels);
}

async function bless(actor, token, item, corpseName) {
  const value = blessingValue(actor, item);
  // dnd5e's applyTempHP only writes when the new value beats the current temporary
  // HP. The same comparison is made here, first, so the chat message only follows a
  // write that actually happened.
  const current = Number(actor.system?.attributes?.hp?.temp) || 0;
  if (value <= current) return;
  await actor.applyTempHP(value);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor, token }),
    content: `<p>${game.i18n.format(`${MODULE_ID}.automation.darkOnesBlessing.chat`, {
      feature: item.name, value, corpse: Handlebars.escapeExpression(corpseName)
    })}</p>`
  });
}
