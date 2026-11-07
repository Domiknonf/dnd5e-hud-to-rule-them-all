import { MODULE_ID } from "../const.mjs";

/**
 * The shared "a creature just dropped to 0 HP" trigger for the table automations,
 * plus the two questions every one of them asks: who did it, and how far away was
 * everybody.
 *
 * Runs on the active GM's client only. Everything downstream - creating a token,
 * granting temporary HP to a creature some player owns, asking a player - needs
 * either GM rights or one single client to decide, and the GM is both.
 *
 * Nothing here writes Combatant flags or touches the economy. What an automation
 * costs (Fungal Infestation's reaction) is booked the normal way: the player's own
 * activity.use() runs through dnd5e.postUseActivity like any other use.
 */

/** { name, setting, run } per automation. Filled by automation/index.mjs. */
const automations = [];

export function onZeroHp(name, setting, run) {
  automations.push({ name, setting, run });
}

/* ------------------------------------------------------------------ */
/*  Who did it                                                         */
/* ------------------------------------------------------------------ */

/**
 * actor.uuid -> { killerUuid, at }, written in dnd5e.preApplyDamage and read in
 * dnd5e.damageActor - the only hook that knows the HP actually changed does not
 * know who changed it, so the attacker is remembered on the way in.
 *
 * Verified live (Foundry 13.351, dnd5e 5.3.3, Midi QoL): Midi applies damage through
 * Actor5e#applyDamage on the GM's client, where dnd5e.preApplyDamage fires BEFORE
 * dnd5e.damageActor with the same actor.uuid - for an unlinked token too.
 * options.midi.sourceActorUuid holds the attacker (a player character's world actor:
 * "Actor.<id>"); options.originatingMessage is absent under Midi.
 *
 * TODO verify live: without Midi, dnd5e's damage-application element and the chat
 * card's context menu pass options.originatingMessage (dnd5e 5.3.3
 * module/applications/components/damage-application.mjs lines 76 and 335,
 * module/documents/chat-message.mjs line 810). Console check: apply damage from a
 * card with `Hooks.once("dnd5e.preApplyDamage", (a, amt, u, o) => console.log(o.originatingMessage?.getAssociatedActor()?.uuid))`.
 *
 * TODO verify live: HP typed into the token HUD go through
 * Actor5e#modifyTokenAttribute -> applyDamage with neither a message nor Midi
 * options (dnd5e 5.3.3 module/documents/actor/actor.mjs lines 697-701), so nothing
 * is remembered and the active-combatant fallback applies. Direct HP updates (sheet,
 * macro) only fire dnd5e.damageActor, never preApplyDamage - same fallback. Check:
 * the same console hook as above stays silent for a sheet edit.
 *
 * Only an attacker that was actually found is stored: an entry with nothing in it
 * would hide the fallback. A player who applies damage on their own client leaves
 * the entry there, not on the GM's - the fallback covers that as well.
 */
const sources = new Map();
const SOURCE_TTL = 5000;

function rememberSource(actor, amount, updates, options) {
  if (!actor?.uuid) return;
  const killerUuid = options?.midi?.sourceActorUuid
    ?? options?.originatingMessage?.getAssociatedActor?.()?.uuid
    ?? null;
  if (killerUuid) sources.set(actor.uuid, { killerUuid, at: Date.now() });
  else sources.delete(actor.uuid);
}

function forgetSource(actor) {
  if (actor?.uuid) sources.delete(actor.uuid);
}

/**
 * The attacker, in order of trust: what the damage application said, then - for HP
 * changed by hand - whoever's turn it is, then nobody.
 */
function killerFor(actor, scene) {
  const entry = sources.get(actor.uuid);
  if (entry && Date.now() - entry.at <= SOURCE_TTL) return entry.killerUuid;
  if (entry) sources.delete(actor.uuid);
  const combat = game.combat;
  if (combat?.started && (!combat.scene || combat.scene.id === scene.id)) {
    return combat.combatant?.actor?.uuid ?? null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  The trigger                                                        */
/* ------------------------------------------------------------------ */

/**
 * Verified live: dnd5e.damageActor fires on the GM's client, also for the synthetic
 * actor of an unlinked token, and changes.hp is the real HP difference (a goblin on
 * 1 HP taking 8 damage reports changes.hp -1 and hp.value 0). Both conditions are
 * needed: hp.value <= 0 alone would fire again for damage to a creature already
 * down; changes.hp < 0 alone for every hit.
 */
function onDamageActor(actor, changes /* , update, userId */) {
  if (!game.user.isActiveGM) return;
  if (!(changes?.hp < 0)) return;
  if (!(actor?.system?.attributes?.hp?.value <= 0)) return;
  const token = actor.token ?? actor.getActiveTokens(false, true)[0];
  const scene = token?.parent;
  if (!token || !scene) return;
  // Read synchronously: dnd5e.applyDamage clears the entry right after this hook.
  const event = { actor, token, scene, killerUuid: killerFor(actor, scene) };
  for (const automation of automations) run(automation, event);
}

/**
 * Each automation on its own: none waits for another, and one that throws does not
 * take the rest down with it.
 */
async function run({ name, setting, run: fn }, event) {
  try {
    if (!game.settings.get(MODULE_ID, setting)) return;
    await fn(event);
  } catch (err) {
    console.error(`${MODULE_ID} | ${name} failed`, err);
  }
}

export function registerZeroHpTrigger() {
  Hooks.on("dnd5e.preApplyDamage", rememberSource);
  Hooks.on("dnd5e.applyDamage", forgetSource);
  Hooks.on("dnd5e.damageActor", onDamageActor);
}

/* ------------------------------------------------------------------ */
/*  Helpers shared by the automations                                  */
/* ------------------------------------------------------------------ */

/**
 * Edge-to-edge distance between two TokenDocuments on `scene`, in the scene's grid
 * units (feet on every scene this table plays on).
 *
 * Measured on the token's own scene, never through canvas.grid: the GM may be
 * looking at a different scene. scene.grid.measurePath is verified live.
 *
 * Square grids: the two nearest occupied squares, measured centre to centre with
 * measurePath, so the world's diagonal rule (5/10/5, Euclidean...) applies - a
 * Large token 10 ft away is 10 ft away, not 15. Hex and gridless: centre to centre.
 */
export function tokenDistance(scene, a, b) {
  const grid = scene.grid;
  const square = grid.type === CONST.GRID_TYPES.SQUARE;
  const points = square ? nearestCells(grid.size, a, b) : [centerOf(grid, a), centerOf(grid, b)];
  return grid.measurePath(points).distance;
}

function nearestCells(size, a, b) {
  const span = (pos, extent) => {
    const first = Math.floor(pos / size);
    return [first, first + Math.max(1, Math.ceil(extent)) - 1];
  };
  // Per axis: the closest pair of indices between two ranges of occupied cells.
  const pick = ([a0, a1], [b0, b1]) => {
    if (a1 < b0) return [a1, b0];
    if (b1 < a0) return [a0, b1];
    const shared = Math.max(a0, b0);
    return [shared, shared];
  };
  const [ax, bx] = pick(span(a.x, a.width), span(b.x, b.width));
  const [ay, by] = pick(span(a.y, a.height), span(b.y, b.height));
  const center = i => (i + 0.5) * size;
  return [{ x: center(ax), y: center(ay) }, { x: center(bx), y: center(by) }];
}

function centerOf(grid, token) {
  const w = grid.sizeX ?? grid.size;
  const h = grid.sizeY ?? grid.size;
  return { x: token.x + (token.width * w) / 2, y: token.y + (token.height * h) / 2 };
}

/**
 * A feature by its dnd5e identifier. item.identifier is dnd5e's getter: the
 * explicit identifier, or the slugified name when there is none - so a hand-made
 * "Fungal Infestation" feat is found as well as the compendium one.
 */
export function featureOf(actor, identifier) {
  return actor?.items.find(i => i.identifier === identifier) ?? null;
}

/** The scene's other tokens with an actor, each actor once, closest first. */
export function othersOnScene(event) {
  const seen = new Set();
  const others = [];
  for (const token of event.scene.tokens) {
    const actor = token.actor;
    if (!actor || token.id === event.token.id || seen.has(actor.uuid)) continue;
    seen.add(actor.uuid);
    others.push({ token, actor, distance: tokenDistance(event.scene, token, event.token) });
  }
  return others.sort((x, y) => x.distance - y.distance);
}
