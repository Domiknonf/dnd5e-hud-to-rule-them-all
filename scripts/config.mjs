import { MODULE_ID, FLAGS, CONFIG_SCHEMA } from "./const.mjs";

/**
 * PER-ACTOR CONFIGURATION, storage layer: the explicit answers to everything this
 * module used to guess. Stored in flags["dnd5e-hud-to-rule-them-all"].config on the
 * ACTOR, and read or written ONLY through this file.
 *
 * Deliberately not the economy flag: that one lives on the Combatant and dies with
 * the encounter (see economy.mjs). Config has to outlive encounters, and it belongs
 * to whoever owns the character - which is also why no GM relay is needed here.
 * Players own their own Actor, so they can write this themselves; the GM owns every
 * Actor, so one dialog lets them configure their players' characters too.
 *
 * WHY THIS FILE IMPORTS NOTHING BUT const.mjs: actions.mjs asks it what a given
 * entry was configured to be, while the dialog in config-app.mjs asks actions.mjs
 * what to suggest. Keeping storage free of the detection breaks what would
 * otherwise be a config <-> actions import cycle.
 */

/* ------------------------------------------------------------------ */
/*  Storage                                                            */
/* ------------------------------------------------------------------ */

/**
 * Which document actually carries the config.
 *
 * An unlinked token (five identical goblins from one prototype) exposes a synthetic
 * Actor whose flags live in that single token's delta - configuring one goblin would
 * leave the other four wrong, and the next encounter would start from scratch again.
 * What a creature can do is a property of the creature, not of one token on the
 * canvas, so it is stored on the base Actor. For linked actors (every player
 * character) this resolves to the actor itself and changes nothing.
 */
export function configTarget(actor) {
  if (!actor) return null;
  if (!actor.isToken) return actor;
  return actor.token?.baseActor ?? game.actors?.get(actor.id) ?? actor;
}

/**
 * Nothing configured. Shared and frozen, the same trick NO_RULE below uses: this is
 * the answer for every actor nobody has touched, which on most worlds is nearly all
 * of them, and it is read several times per render.
 */
const NO_CONFIG = Object.freeze({});

/**
 * Bring a stored config forward to CONFIG_SCHEMA.
 *
 * THERE IS NOTHING TO DO YET, and that is exactly why it is worth landing: from this
 * version on a stored config says which shape it is, so a later change to that shape
 * has something to branch on. Without the stamp there is no way to tell a config
 * written under the old meaning of a field from one written under the new one, and the
 * only honest options left are to break people's settings or to never change the shape
 * again.
 *
 * A config written before the stamp existed reports version 0. That is treated as the
 * same shape as 1 on purpose: the last real shape change (`sort` becoming an absolute
 * grid cell rather than a rank within a pool) predates it, so there is nothing left in
 * the wild that 0 could mean other than "current".
 *
 * PURE, and repaired on the READ - it hands back a corrected copy and never writes,
 * the same way the economy's staleness guard does. The next save persists it, because
 * setActorConfig stamps every write.
 */
function migrate(config) {
  if ((Number(config.schema) || 0) >= CONFIG_SCHEMA) return config;
  // 0 -> 1: the version changed, the shape did not.
  return { ...config, schema: CONFIG_SCHEMA };
}

/** Raw config object for an actor. Always an object, never null. */
export function getActorConfig(actor) {
  const stored = configTarget(actor)?.getFlag?.(MODULE_ID, FLAGS.ACTOR_CONFIG);
  return stored ? migrate(stored) : NO_CONFIG;
}

/**
 * Replace the whole config object. `recursive: false` matters: setFlag merges, so a
 * removed key would otherwise survive forever and "reset to automatic" could never
 * actually clear anything.
 *
 * The schema stamp is applied HERE rather than by the callers, and that is the point of
 * putting it in the one write path: `config-app`'s #write() and #onSubmit both rebuild
 * the config object field by field, so anything they do not name is deleted on the next
 * save. A version they had to remember to carry across would be forgotten exactly once
 * and then be worth nothing.
 */
export async function setActorConfig(actor, config) {
  const target = configTarget(actor);
  if (!target?.isOwner) return false;
  await target.update(
    { [`flags.${MODULE_ID}.${FLAGS.ACTOR_CONFIG}`]: { ...config, schema: CONFIG_SCHEMA } },
    { diff: false, recursive: false }
  );
  return true;
}

/* ------------------------------------------------------------------ */
/*  Per-entry overrides                                                */
/* ------------------------------------------------------------------ */

/**
 * Key for one configurable HUD entry, under `config.entries`.
 *
 * Built from document IDs, NOT uuids. A synthetic token actor's uuid carries its
 * scene and token ("Scene.x.Token.y.Actor.z.Item.a"), so a uuid key written for one
 * goblin would never match the base actor the config is stored on. Item and activity
 * IDs survive that trip unchanged.
 *
 * Re-importing an item gives it a fresh ID and orphans its entry. That is accepted:
 * the alternative (matching on name) breaks on duplicates, and a stale key is a few
 * dead bytes rather than a wrong rule applied to the wrong thing.
 */
export function entryKey(item, activity = null) {
  return activity ? `${item?.id}:${activity.id}` : `${item?.id}`;
}

/**
 * The empty rule, shared. Handed back for every entry nobody has configured, which
 * on a fresh actor is all of them - a new `{}` per lookup was one throwaway object
 * per activity per render. Frozen so a caller cannot make it stop being empty.
 */
const NO_RULE = Object.freeze({});

/**
 * The whole rules table for an actor, read ONCE. `entryKey` lookups against it are
 * plain property reads, while every call to getActorConfig() below costs a
 * configTarget() resolution plus a Document#getFlag - and getFlag validates the flag
 * scope against every active module before it reads anything.
 *
 * That is why the hot enumeration in actions.mjs takes the table once and resolves
 * against it (see ruleFor) instead of asking per activity: the same answer, one flag
 * read instead of several hundred.
 */
export function entryRules(actor) {
  return getActorConfig(actor).entries ?? NO_RULE;
}

/**
 * What was configured for an entry, resolved most-specific-first out of an already
 * read rules table: a rule set on one activity beats the one set on its item, which
 * is what lets "the whole item is a bonus action" coexist with "except this one
 * activity".
 */
export function ruleFor(rules, item, activity = null) {
  const base = rules[entryKey(item)] ?? NO_RULE;
  if (!activity) return base;
  const own = rules[entryKey(item, activity)];
  // Merge FIELD BY FIELD, not object by object. Reordering writes a `sort` onto
  // every activity, so an activity rule almost always exists - and returning it
  // whole meant an item-level `pool` was never read again once anything had been
  // dragged. The activity still wins per field, which is the point.
  // Nothing to merge -> hand back the item rule itself rather than a copy of it.
  if (!own) return base;
  return base === NO_RULE ? own : { ...base, ...own };
}

/** The same answer for a single entry, for callers that have no table in hand. */
export function entryConfig(actor, item, activity = null) {
  return ruleFor(entryRules(actor), item, activity);
}

/* ------------------------------------------------------------------ */
/*  Arranging                                                          */
/* ------------------------------------------------------------------ */

/**
 * Copy the rules table for editing. Shallow on purpose: the map is copied, each rule
 * is replaced rather than mutated, so nothing a caller of ruleFor() still holds can
 * change under it (see the "never mutate what ruleFor hands back" rule).
 */
function editableEntries(config) {
  return { ...(config.entries ?? {}) };
}

/**
 * Write a display position onto every button, taken from WHERE IT SITS IN THE LIST.
 * `buttons` is a list of entries as actions.mjs produces them - the position goes on
 * every config key a button covers, or a grouped button would come apart the moment
 * it moved.
 *
 * Two things the index carries, and both callers rely on it:
 *
 * - `sort` is GLOBAL across the pools, not a position within one. The played
 *   creature's bar is a single grid, so an icon dragged onto an icon from another
 *   pool has to be able to trade places with it. A pool column just renders its own
 *   entries in ascending order and gets the answer it always did.
 * - HOLES IN THE LIST ARE THE POINT. An empty place stays empty - it is a cell of
 *   the grid nobody is standing on - which is what lets a player put space between
 *   two groups of icons. Callers with nothing to leave empty simply pass a packed
 *   list and get the dense numbering they always got.
 */
export async function setEntryOrder(actor, buttons) {
  const config = getActorConfig(actor);
  const entries = editableEntries(config);
  buttons.forEach((button, i) => {
    for (const key of button?.keys ?? []) entries[key] = { ...(entries[key] ?? {}), sort: i };
  });
  return setActorConfig(actor, { ...config, entries });
}

/** Take one button off the bar, or put it back. */
export async function setEntryHidden(actor, keys, hidden) {
  const config = getActorConfig(actor);
  const entries = editableEntries(config);
  for (const key of keys ?? []) {
    const rule = { ...(entries[key] ?? {}) };
    if (hidden) rule.hidden = true;
    else delete rule.hidden;
    if (Object.keys(rule).length) entries[key] = rule;
    else delete entries[key];
  }
  return setActorConfig(actor, { ...config, entries });
}

/**
 * Drop every stored position, back to the automatic order. Only `sort` goes: what
 * pool something belongs to, whether it counts as an attack and what is hidden are
 * answers to different questions and are reset per entry in the dialog.
 */
export async function clearEntryOrder(actor) {
  const config = getActorConfig(actor);
  const entries = {};
  for (const [key, rule] of Object.entries(config.entries ?? {})) {
    const { sort, ...rest } = rule;
    if (Object.keys(rest).length) entries[key] = rest;
  }
  const next = { ...config };
  if (Object.keys(entries).length) next.entries = entries;
  else delete next.entries;
  return setActorConfig(actor, next);
}
