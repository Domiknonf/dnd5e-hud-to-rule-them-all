import { MODULE_ID } from "../const.mjs";
import { combatantFor } from "../economy.mjs";
import { featureOf, othersOnScene } from "./zero-hp.mjs";

/**
 * Fungal Infestation (Circle of Spores, TCE): a Small or Medium beast or humanoid
 * dies within 10 ft of the druid; the druid may spend a reaction and one use to make
 * it rise as a 1 HP zombie that acts right after them, obeys them, can only take the
 * Attack action with one melee attack, and falls apart after an hour.
 *
 * Split along who may do what: the GM's client notices the death and creates the
 * zombie; the druid's player is asked, and fires the activity themselves. That is
 * what keeps the economy honest without this file touching it - the use goes
 * through dnd5e.postUseActivity like any other reaction, and the gate in module.mjs
 * decides whether there is a reaction left to spend.
 */

// Concatenated rather than a template literal: tools/verify.mjs reads every
// MODULE_ID-prefixed template literal as an i18n key, and this is a query name.
export const QUERY = MODULE_ID + ".fungalInfestation";
const IDENTIFIER = "fungal-infestation";
const RANGE = 10;
const QUERY_TIMEOUT = 30000;
const TYPES = new Set(["beast", "humanoid"]);
const SIZES = new Set(["sm", "med"]);
const SOURCE_NAME = "Fungal Zombie";
const PACKS = ["dnd-players-handbook.actors", "dnd5e.actors24"];

/** Corpses being decided on or already raised - one animation per death. */
const claimed = new Set();

export async function fungalInfestation(event) {
  const { actor, token } = event;
  // A player character at 0 HP is dying, not dead.
  if (actor.type === "character") return;
  if (!TYPES.has(actor.system?.details?.type?.value)) return;
  if (!SIZES.has(actor.system?.traits?.size)) return;
  if (claimed.has(token.uuid)) return;

  const druids = othersOnScene(event).filter(({ actor: druid, distance }) => {
    if (distance > RANGE) return false;
    if (!(druid.system?.attributes?.hp?.value > 0)) return false;
    return featureOf(druid, IDENTIFIER)?.system?.uses?.value > 0;
  });
  if (!druids.length) return;

  claimed.add(token.uuid);
  try {
    // One after the other, closest first, until somebody says yes.
    for (const druid of druids) {
      const item = featureOf(druid.actor, IDENTIFIER);
      const accepted = await ask(druid.actor, item, token.name);
      if (!accepted) continue;
      await raise(event, druid, item);
      return;
    }
  } finally {
    // A corpse nobody raised stays claimable: it cannot die a second time anyway
    // (changes.hp < 0 at 0 HP never happens), and keeping it would only leak.
    claimed.delete(token.uuid);
  }
}

/**
 * The druid's player if one is online, the GM otherwise. A query to oneself is
 * answered in place rather than through the socket.
 */
async function ask(druid, item, corpseName) {
  const user = game.users.find(u => u.active && !u.isGM && druid.testUserPermission(u, "OWNER"))
    ?? game.user;
  const data = { actorUuid: druid.uuid, itemId: item.id, corpseName, timeout: QUERY_TIMEOUT };
  try {
    if (user === game.user) return (await answerQuery(data)) === true;
    return (await user.query(QUERY, data, { timeout: QUERY_TIMEOUT })) === true;
  } catch (err) {
    // A timeout lands here as well: no answer is a no.
    console.warn(`${MODULE_ID} | Fungal Infestation: no answer from ${user.name}`, err);
    return false;
  }
}

/**
 * CONFIG.queries handler, registered on every client. Returns true only once the
 * reaction activity has actually been used.
 *
 * TODO verify live: what activity.use() resolves to under Midi QoL - this treats
 * any truthy result as "used" and undefined/null as "cancelled or gated". Check in
 * the console with a druid selected:
 *   const a = _token.actor.items.find(i => i.identifier === "fungal-infestation")
 *     .system.activities.find(a => a.activation?.type === "reaction");
 *   console.log(await a.use({}, { configure: false }));
 * once with a reaction left (expect a result) and once without under enforcement
 * "Block" (expect undefined).
 */
export async function answerQuery({ actorUuid, itemId, corpseName, timeout }) {
  const asked = Date.now();
  try {
    const actor = await fromUuid(actorUuid);
    const item = actor?.items.get(itemId);
    const activity = item?.system.activities?.find(a => a.activation?.type === "reaction");
    if (!activity) return false;
    const escape = Handlebars.escapeExpression;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: item.name },
      content: `<p>${game.i18n.format(`${MODULE_ID}.automation.fungalInfestation.prompt`, {
        corpse: escape(corpseName), druid: escape(actor.name)
      })}</p>`,
      rejectClose: false
    });
    if (!confirmed) return false;
    // The GM stopped waiting; using the reaction now would spend it for nothing.
    if (timeout && Date.now() - asked > timeout - 1000) {
      ui.notifications.warn(`${MODULE_ID}.automation.fungalInfestation.tooLate`, { localize: true });
      return false;
    }
    const result = await activity.use({}, { configure: false });
    return !!result;
  } catch (err) {
    console.error(`${MODULE_ID} | Fungal Infestation prompt failed`, err);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  The zombie                                                         */
/* ------------------------------------------------------------------ */

let sourcePromise = null;

/**
 * The world actor every zombie is made from, imported once. Shared promise so two
 * deaths in the same moment do not import it twice.
 *
 * TODO verify live: WorldCollection#importFromCompendium(pack, id, updateData)
 * returns the created Actor. Check: `game.actors.getName("Fungal Zombie")` exists
 * after the first zombie, and only once.
 */
function zombieSource() {
  const existing = game.actors.getName(SOURCE_NAME);
  if (existing) return Promise.resolve(existing);
  sourcePromise ??= (async () => {
    for (const id of PACKS) {
      const pack = game.packs.get(id);
      if (!pack) continue;
      const entry = (await pack.getIndex()).find(e => e.name === "Zombie");
      if (!entry) continue;
      return game.actors.importFromCompendium(pack, entry._id, { name: SOURCE_NAME });
    }
    return null;
  })().finally(() => { sourcePromise = null; });
  return sourcePromise;
}

async function raise(event, druid, item) {
  const { token: corpse, scene } = event;
  const source = await zombieSource();
  if (!source) {
    ui.notifications.error(`${MODULE_ID}.automation.fungalInfestation.noSource`, { localize: true });
    return;
  }

  /**
   * TODO verify live: an unsaved TokenDocument from Actor#getTokenDocument carries
   * a `delta` whose updateSource accepts system.attributes.hp.value and ownership,
   * and toObject() keeps both. Check: the new zombie's sheet shows 1 HP and the
   * druid's player can control it.
   */
  const tokenDoc = await source.getTokenDocument({
    x: corpse.x,
    y: corpse.y,
    elevation: corpse.elevation,
    actorLink: false,
    name: game.i18n.format(`${MODULE_ID}.automation.fungalInfestation.tokenName`, { corpse: corpse.name }),
    disposition: druid.token.disposition
  }, { parent: scene });
  tokenDoc.delta.updateSource({
    system: { attributes: { hp: { value: 1 } } },
    ownership: foundry.utils.deepClone(druid.actor.ownership)
  });
  const [zombie] = await scene.createEmbeddedDocuments("Token", [tokenDoc.toObject()]);
  if (!zombie) return;

  const combat = game.combat;
  if (combat && (!combat.scene || combat.scene.id === scene.id)) {
    // Right after the druid: the same count, a hair lower.
    const initiative = combatantFor(druid.actor)?.initiative;
    await combat.createEmbeddedDocuments("Combatant", [{
      tokenId: zombie.id,
      sceneId: scene.id,
      actorId: zombie.actorId,
      hidden: zombie.hidden,
      initiative: Number.isFinite(initiative) ? initiative - 0.01 : null
    }]);
  }

  // A reminder, not a timer: nothing deletes the zombie, the GM does after an hour.
  await zombie.actor?.createEmbeddedDocuments("ActiveEffect", [{
    name: item.name,
    img: item.img,
    origin: item.uuid,
    description: game.i18n.format(`${MODULE_ID}.automation.fungalInfestation.effect`, { druid: druid.actor.name }),
    duration: {
      seconds: 3600,
      startTime: game.time.worldTime,
      combat: combat?.id ?? null,
      startRound: combat?.round ?? null,
      startTurn: combat?.turn ?? null
    }
  }]);

  // Hidden rather than deleted: the corpse still carries its loot.
  await corpse.update({ hidden: true });
}
