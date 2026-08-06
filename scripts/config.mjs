import {
  MODULE_ID, FLAGS, CONFIGURABLE_POOLS, CONFIG_LIMITS, DEFAULT_ATTACKS_PER_ACTION
} from "./const.mjs";
import { guessAttacksPerAction } from "./actions.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * PER-ACTOR CONFIGURATION: the explicit answers to everything this module used to
 * guess. Stored in flags["dnd5e-hud-to-rule-them-all"].config on the ACTOR, and
 * read or written ONLY through this file.
 *
 * Deliberately not the economy flag: that one lives on the Combatant and dies with
 * the encounter (see economy.mjs). Config has to outlive encounters, and it belongs
 * to whoever owns the character - which is also why no GM relay is needed here.
 * Players own their own Actor, so they can write this themselves; the GM owns every
 * Actor, so the same dialog lets them configure their players' characters too.
 *
 * The detection in actions.mjs is NOT removed by any of this. It is demoted to a
 * suggestion: it prefills the dialog and still serves as the runtime fallback while
 * nothing has been configured (which is what keeps a freshly dropped pack of NPCs
 * usable without clicking through six dialogs first).
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
 * Attacks per action is a property of the creature, not of one token on the canvas,
 * so it is stored on the base Actor. For linked actors (every player character) this
 * resolves to the actor itself and changes nothing.
 */
export function configTarget(actor) {
  if (!actor) return null;
  if (!actor.isToken) return actor;
  return actor.token?.baseActor ?? game.actors?.get(actor.id) ?? actor;
}

/** Raw config object for an actor. Always an object, never null. */
export function getActorConfig(actor) {
  return configTarget(actor)?.getFlag?.(MODULE_ID, FLAGS.ACTOR_CONFIG) ?? {};
}

/**
 * Replace the whole config object. `recursive: false` matters: setFlag merges, so a
 * removed key would otherwise survive forever and "reset to automatic" could never
 * actually clear anything.
 */
export async function setActorConfig(actor, config) {
  const target = configTarget(actor);
  if (!target?.isOwner) return false;
  await target.update(
    { [`flags.${MODULE_ID}.${FLAGS.ACTOR_CONFIG}`]: config },
    { diff: false, recursive: false }
  );
  return true;
}

/* ------------------------------------------------------------------ */
/*  Suggestions                                                        */
/* ------------------------------------------------------------------ */

/** What the automatic detection would say. null when it has no opinion. */
export function attackSuggestion(actor) {
  return guessAttacksPerAction(actor) ?? null;
}

/**
 * Set of pools whose configured size differs from the world default, plus the
 * attack divergence. Drives the small dot on the HUD's gear: a level-up can change
 * what the detection would suggest without changing anything visible in the bar
 * (Extra Attack at level 11 adds no new hotbar entry), so the dot is the only hint
 * that a character's configuration is worth another look. Passive by design - it
 * never overwrites what was configured.
 */
export function configDivergence(actor) {
  const configured = Number(getActorConfig(actor).attacksPerAction);
  if (!Number.isFinite(configured) || configured <= 0) return null;
  const suggested = attackSuggestion(actor);
  if (!suggested || suggested === configured) return null;
  return { suggested, configured };
}

/* ------------------------------------------------------------------ */
/*  Dialog                                                             */
/* ------------------------------------------------------------------ */

/** Blank input -> null ("not configured"), otherwise a clamped integer. */
function toInt(value, { min, max }) {
  if (value === null || value === undefined || value === "") return null;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.clamp(n, min, max);
}

/**
 * Every actor this user may configure: the current encounter's combatants first
 * (that is what the gear was clicked for), then owned characters so the dialog is
 * useful out of combat too - the GM's "let me fix my players' sheets before the
 * session" case. Collapsed through configTarget(), so five goblins appear once.
 */
function configurableActors() {
  const found = new Map();
  const add = (actor) => {
    const target = configTarget(actor);
    if (!target?.isOwner) return;
    if (!found.has(target.uuid)) found.set(target.uuid, target);
  };
  for (const combatant of game.combat?.combatants ?? []) add(combatant.actor);
  for (const actor of game.actors ?? []) if (actor.type === "character") add(actor);
  return [...found.values()];
}

export class HudConfig extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "hudtra-config",
    classes: ["hudtra-config"],
    tag: "form",
    window: { title: `${MODULE_ID}.config.title`, icon: "fa-solid fa-sliders", resizable: true },
    position: { width: 560, height: "auto" },
    form: { handler: HudConfig.#onSubmit, submitOnChange: false, closeOnSubmit: false },
    actions: {
      pickActor: HudConfig.#onPickActor,
      clear: HudConfig.#onClear
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/config.hbs` }
  };

  /** Stored as a uuid, not as the document: re-renders resolve it fresh. */
  #actorUuid = null;

  get actor() {
    const list = configurableActors();
    return list.find(a => a.uuid === this.#actorUuid) ?? list[0] ?? null;
  }

  /** Point the dialog at an actor (the HUD gear passes the shown combatant's). */
  selectActor(actor) {
    this.#actorUuid = configTarget(actor)?.uuid ?? null;
    return this;
  }

  async _prepareContext() {
    const actor = this.actor;
    const config = actor ? getActorConfig(actor) : {};
    const suggested = actor ? attackSuggestion(actor) : null;

    const pools = Object.entries(CONFIGURABLE_POOLS).map(([key, def]) => ({
      key,
      label: game.i18n.localize(`${MODULE_ID}.pool.${key}`),
      value: config.max?.[key] ?? "",
      placeholder: String(game.settings.get(MODULE_ID, def.setting) ?? 0)
    }));

    return {
      actors: configurableActors().map(a => ({
        uuid: a.uuid, name: a.name, img: a.img, selected: a.uuid === actor?.uuid
      })),
      actor,
      attacksPerAction: config.attacksPerAction ?? "",
      attacksPlaceholder: String(suggested ?? DEFAULT_ATTACKS_PER_ACTION),
      attacksHint: suggested
        ? game.i18n.format(`${MODULE_ID}.config.attacksPerAction.suggested`, { suggested })
        : game.i18n.format(`${MODULE_ID}.config.attacksPerAction.none`, { fallback: DEFAULT_ATTACKS_PER_ACTION }),
      pools,
      limits: CONFIG_LIMITS
    };
  }

  /* -------------------------------------------- */

  static async #onSubmit(event, form, formData) {
    const actor = this.actor;
    if (!actor) return;
    const raw = foundry.utils.expandObject(formData.object);
    const config = {};

    const attacks = toInt(raw.attacksPerAction, CONFIG_LIMITS.attacksPerAction);
    if (attacks !== null) config.attacksPerAction = attacks;

    const max = {};
    for (const key of Object.keys(CONFIGURABLE_POOLS)) {
      const n = toInt(raw.max?.[key], CONFIG_LIMITS.poolMax);
      if (n !== null) max[key] = n;
    }
    if (Object.keys(max).length) config.max = max;

    await setActorConfig(actor, config);
    ui.notifications.info(game.i18n.format(`${MODULE_ID}.config.saved`, { name: actor.name }));
    return this.render();
  }

  static async #onPickActor(event, target) {
    this.#actorUuid = target.dataset.actorUuid ?? null;
    return this.render();
  }

  static async #onClear() {
    const actor = this.actor;
    if (!actor) return;
    await setActorConfig(actor, {});
    ui.notifications.info(game.i18n.format(`${MODULE_ID}.config.cleared`, { name: actor.name }));
    return this.render();
  }
}

/* ---------------------------------------------- */

/**
 * Open the dialog, optionally on a specific actor. Reuses an already-open window
 * (v13 registers every rendered ApplicationV2 in foundry.applications.instances by
 * id) instead of stacking a second one on the same id.
 */
export function openConfig(actor = null) {
  const existing = foundry.applications.instances?.get("hudtra-config");
  const app = existing instanceof HudConfig ? existing : new HudConfig();
  if (actor) app.selectActor(actor);
  return app.render({ force: true });
}
