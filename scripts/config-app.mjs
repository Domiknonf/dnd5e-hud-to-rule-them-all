import {
  MODULE_ID, CONFIGURABLE_POOLS, CONFIG_LIMITS, DEFAULT_ATTACKS_PER_ACTION,
  ASSIGNABLE_POOLS, RESOURCES
} from "./const.mjs";
import { guessAttacksPerAction, collectConfigurable } from "./actions.mjs";
import { configTarget, getActorConfig, setActorConfig, entryKey } from "./config.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * PER-ACTOR CONFIGURATION, dialog layer. Storage lives in config.mjs; this file is
 * what the owner (or the GM) uses to fill it in.
 *
 * The detection in actions.mjs is NOT removed by any of this. It is demoted to a
 * suggestion: it prefills this dialog and still serves as the runtime fallback while
 * nothing has been configured (which is what keeps a freshly dropped pack of NPCs
 * usable without clicking through six statblocks first).
 */

/* ------------------------------------------------------------------ */
/*  Suggestions                                                        */
/* ------------------------------------------------------------------ */

/**
 * What the automatic detection would say: `{ count, feature }` or null. The feature
 * name is what lets the notice below quote the actual cause back at the player.
 */
export function attackSuggestion(actor) {
  return guessAttacksPerAction(actor) ?? null;
}

/**
 * The "something changed, take a look" notice behind the mark on the HUD's gear.
 * Returns `{ count, feature, configured }` or null.
 *
 * A level-up can change what detection suggests without changing anything visible
 * in the bar - Extra Attack adds no new hotbar entry - so this mark is the only
 * hint a player gets. It never rewrites the configured value; the dialog offers the
 * change and the player decides.
 *
 * Three ways to have no notice, in order:
 * 1. Nothing configured. Detection is already in force, so there is nothing to
 *    report - this is the normal state for NPCs and it keeps them silent.
 * 2. The suggestion matches what is configured. Nothing to change.
 * 3. That exact suggestion was dismissed before (`seenAttackSuggestion`).
 *
 * Note what (3) stores: the dismissed COUNT, not a boolean. Dismissing "3" silences
 * 3 forever, but the next tier suggesting 4 raises the mark again on its own. A
 * boolean would have to be reset by hand and would silently swallow every later
 * level-up - which is the whole thing this is meant to catch.
 */
export function attackNotice(actor) {
  const suggestion = attackSuggestion(actor);
  if (!suggestion) return null;
  const config = getActorConfig(actor);
  const configured = Number(config.attacksPerAction);
  if (!Number.isFinite(configured) || configured <= 0) return null;
  if (configured === suggestion.count) return null;
  if (Number(config.seenAttackSuggestion) === suggestion.count) return null;
  return { ...suggestion, configured };
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
    position: { width: 760, height: 640 },
    form: { handler: HudConfig.#onSubmit, submitOnChange: false, closeOnSubmit: false },
    actions: {
      pickActor: HudConfig.#onPickActor,
      applyNotice: HudConfig.#onApplyNotice,
      dismissNotice: HudConfig.#onDismissNotice,
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
    const suggestion = actor ? attackSuggestion(actor) : null;
    const notice = actor ? attackNotice(actor) : null;

    const pools = Object.entries(CONFIGURABLE_POOLS).map(([key, def]) => ({
      key,
      label: game.i18n.localize(`${MODULE_ID}.pool.${key}`),
      value: config.max?.[key] ?? "",
      placeholder: String(game.settings.get(MODULE_ID, def.setting) ?? 0)
    }));

    return {
      actors: configurableActors().map(a => ({
        uuid: a.uuid, name: a.name, img: a.img,
        selected: a.uuid === actor?.uuid,
        notice: !!attackNotice(a)
      })),
      actor,
      // The banner quotes the feature that caused the suggestion, so the player can
      // check it against their sheet instead of trusting a bare number.
      notice: notice && {
        ...notice,
        body: game.i18n.format(`${MODULE_ID}.config.notice.body`, notice),
        apply: game.i18n.format(`${MODULE_ID}.config.notice.apply`, notice),
        dismiss: game.i18n.format(`${MODULE_ID}.config.notice.dismiss`, notice)
      },
      attacksPerAction: config.attacksPerAction ?? "",
      attacksPlaceholder: String(suggestion?.count ?? DEFAULT_ATTACKS_PER_ACTION),
      attacksHint: suggestion
        ? game.i18n.format(`${MODULE_ID}.config.attacksPerAction.suggested`, { suggested: suggestion.count })
        : game.i18n.format(`${MODULE_ID}.config.attacksPerAction.none`, { fallback: DEFAULT_ATTACKS_PER_ACTION }),
      pools,
      entries: actor ? this.#prepareEntries(actor, config) : [],
      limits: CONFIG_LIMITS
    };
  }

  /**
   * One row per configurable activity. Every dropdown carries an explicit "auto"
   * option showing what detection would pick, so the row states both what the module
   * thinks and what was decided - and "auto" stays selectable, which is how a rule
   * gets removed again.
   */
  #prepareEntries(actor, config) {
    const stored = config.entries ?? {};
    const poolLabel = key => game.i18n.localize(`${MODULE_ID}.pool.${key}`);

    return collectConfigurable(actor).map(row => {
      const set = stored[row.key] ?? {};
      const autoPool = row.auto.pool ? poolLabel(row.auto.pool) : game.i18n.localize(`${MODULE_ID}.config.entries.dropped`);
      return {
        key: row.key,
        name: row.name,
        detail: row.detail,
        img: row.img,
        passive: row.passive,
        hidden: set.hidden === true,
        pools: [
          { value: "", label: game.i18n.format(`${MODULE_ID}.config.entries.auto`, { value: autoPool }), selected: !set.pool }
        ].concat(ASSIGNABLE_POOLS.filter(k => RESOURCES[k]).map(k => ({
          value: k, label: poolLabel(k), selected: set.pool === k
        }))),
        attacks: [
          { value: "", selected: typeof set.attack !== "boolean",
            label: game.i18n.format(`${MODULE_ID}.config.entries.auto`, {
              value: game.i18n.localize(`${MODULE_ID}.config.entries.attack.${row.auto.attack ? "yes" : "no"}`)
            }) },
          { value: "yes", label: game.i18n.localize(`${MODULE_ID}.config.entries.attack.yes`), selected: set.attack === true },
          { value: "no",  label: game.i18n.localize(`${MODULE_ID}.config.entries.attack.no`),  selected: set.attack === false }
        ]
      };
    });
  }

  /* -------------------------------------------- */

  static async #onSubmit(event, form, formData) {
    const actor = this.actor;
    if (!actor) return;
    const raw = foundry.utils.expandObject(formData.object);
    const previous = getActorConfig(actor);
    const config = {};

    // The write replaces the whole object (see setActorConfig), so anything the form
    // does not render has to be carried across by hand. seenAttackSuggestion is the
    // only such field today - losing it would resurrect a dismissed notice on the
    // next save.
    if (previous.seenAttackSuggestion !== undefined) {
      config.seenAttackSuggestion = previous.seenAttackSuggestion;
    }

    const attacks = toInt(raw.attacksPerAction, CONFIG_LIMITS.attacksPerAction);
    if (attacks !== null) config.attacksPerAction = attacks;

    const max = {};
    for (const key of Object.keys(CONFIGURABLE_POOLS)) {
      const n = toInt(raw.max?.[key], CONFIG_LIMITS.poolMax);
      if (n !== null) max[key] = n;
    }
    if (Object.keys(max).length) config.max = max;

    // Per-entry rules. Only non-default values are kept, so a row left on "auto"
    // everywhere stores nothing at all - and because the form renders every entry
    // this actor still has, rules orphaned by a deleted item prune themselves here.
    const entries = {};
    for (const [key, value] of Object.entries(raw.entries ?? {})) {
      const rule = {};
      if (value.pool && RESOURCES[value.pool]) rule.pool = value.pool;
      if (value.attack === "yes") rule.attack = true;
      else if (value.attack === "no") rule.attack = false;
      if (value.hidden === true) rule.hidden = true;
      if (Object.keys(rule).length) entries[key] = rule;
    }
    if (Object.keys(entries).length) config.entries = entries;

    await setActorConfig(actor, config);
    ui.notifications.info(game.i18n.format(`${MODULE_ID}.config.saved`, { name: actor.name }));
    return this.render();
  }

  static async #onPickActor(event, target) {
    this.#actorUuid = target.dataset.actorUuid ?? null;
    return this.render();
  }

  /** Take the suggestion: the configured count becomes the suggested one. */
  static async #onApplyNotice() {
    const actor = this.actor;
    const notice = actor ? attackNotice(actor) : null;
    if (!notice) return;
    await setActorConfig(actor, { ...getActorConfig(actor), attacksPerAction: notice.count });
    ui.notifications.info(game.i18n.format(`${MODULE_ID}.config.notice.applied`, {
      name: actor.name, count: notice.count
    }));
    return this.render();
  }

  /**
   * Keep the configured value and silence this suggestion - by remembering the
   * COUNT that was dismissed, not a flag. A later level-up suggesting a different
   * number raises the mark again without anything having to be reset.
   */
  static async #onDismissNotice() {
    const actor = this.actor;
    const notice = actor ? attackNotice(actor) : null;
    if (!notice) return;
    await setActorConfig(actor, { ...getActorConfig(actor), seenAttackSuggestion: notice.count });
    ui.notifications.info(game.i18n.format(`${MODULE_ID}.config.notice.dismissed`, {
      name: actor.name, configured: notice.configured
    }));
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
