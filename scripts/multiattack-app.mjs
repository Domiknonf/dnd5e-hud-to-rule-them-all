import { MODULE_ID, CONFIG_LIMITS } from "./const.mjs";
import { collectConfigurable, suggestMultiattack } from "./actions.mjs";
import { configTarget, getActorConfig, setActorConfig, multiattackKey } from "./config.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * MULTIATTACK EDITOR. Writes `config.multiattack.options`, the shape the economy
 * reads:
 *
 *   options: [ { parts: [ { key, count } ] } ]
 *
 * One option is one ALTERNATIVE - the creature picks exactly one per Attack action.
 * Several parts inside one option are COMBINED. So "two Holy Bursts or three Radiant
 * Swords" is two single-part options, while "one bite and two claws" is one option
 * with two parts. Between them that covers every Multiattack shape 5e uses.
 *
 * Nothing here asks which alternative is being taken at the table: economy.mjs keeps
 * every option alive until a use rules it out (see viableOptions). Clicking an
 * attack that appears in several options simply leaves several open.
 */

const clampCount = (value) => Math.clamp(
  Math.floor(Number(value) || 1),
  CONFIG_LIMITS.attacksPerAction.min,
  CONFIG_LIMITS.attacksPerAction.max
);

export class MultiattackConfig extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "hudtra-multiattack",
    classes: ["hudtra-config", "hudtra-multiattack"],
    tag: "form",
    window: { title: `${MODULE_ID}.multiattack.title`, icon: "fa-solid fa-hand-fist", resizable: true },
    position: { width: 620, height: "auto" },
    form: { handler: MultiattackConfig.#onSubmit, submitOnChange: false, closeOnSubmit: true },
    actions: {
      addOption: MultiattackConfig.#onAddOption,
      removeOption: MultiattackConfig.#onRemoveOption,
      addPart: MultiattackConfig.#onAddPart,
      removePart: MultiattackConfig.#onRemovePart,
      useSuggestion: MultiattackConfig.#onUseSuggestion,
      clearAll: MultiattackConfig.#onClearAll
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/multiattack.hbs` }
  };

  #actorUuid = null;

  /**
   * The options being edited, and the ONLY source of truth for the structure: how
   * many alternatives exist and how many rows each one has.
   *
   * It must never be rebuilt from the form, and that is not a matter of taste. An
   * alternative with no rows renders no form fields at all, so reading the structure
   * back out of the DOM dropped every empty one - which is precisely the state a
   * freshly added alternative is in. "Add alternative" followed by "Add attack" made
   * the alternative disappear instead, because it was already gone by the time the
   * row was inserted into it.
   *
   * The form supplies VALUES only (key and count), folded back in by #syncValues.
   */
  #draft = null;

  get actor() {
    const doc = this.#actorUuid ? fromUuidSync(this.#actorUuid) : null;
    return doc?.isOwner ? doc : null;
  }

  selectActor(actor) {
    this.#actorUuid = configTarget(actor)?.uuid ?? null;
    this.#draft = null;
    return this;
  }

  /** The attack entries an alternative may name. Empty means nothing to configure. */
  #attacks() {
    const actor = this.actor;
    return actor ? collectConfigurable(actor).filter(row => row.pool === "action" && row.attack) : [];
  }

  /**
   * Whether the draft is still nothing but the statblock's reading. Drives the "this
   * is not stored yet" hint, so a prefill can never be mistaken for a configuration
   * that already exists. Cleared by the first edit and by saving.
   */
  #suggested = false;

  /**
   * The draft, seeded the first time it is asked for - from what is stored, and
   * failing that from the statblock.
   *
   * Seeded rather than blank for the same reason the config dialog's zones are: an
   * editor that opens empty is something you must fill in before the bar works,
   * while one that opens with detection's reading is a correction surface. This
   * stays a suggestion in the sense the rest of the module means it - nothing is
   * written until Save, and closing the dialog declines the offer.
   */
  #options() {
    if (!this.#draft) {
      const stored = getActorConfig(this.actor).multiattack?.options;
      const configured = Array.isArray(stored) && stored.length > 0;
      this.#suggested = !configured;
      this.#draft = configured ? foundry.utils.deepClone(stored) : suggestMultiattack(this.actor);
    }
    return this.#draft;
  }

  /**
   * Fold what is currently typed back into the draft, so a structural edit (which
   * re-renders) keeps it. Values only - the structure is walked from the draft, and
   * a field with no matching row is simply ignored.
   */
  #syncValues() {
    const options = this.#options();
    if (!this.element) return options;
    const FDE = foundry.applications.ux?.FormDataExtended ?? FormDataExtended;
    const raw = foundry.utils.expandObject(new FDE(this.element).object);
    options.forEach((option, o) => {
      const fields = raw.options?.[o]?.parts;
      if (!fields) return;
      (option.parts ?? []).forEach((part, p) => {
        const field = fields[p];
        if (!field) return;
        if (field.key !== undefined) part.key = field.key;
        if (field.count !== undefined) part.count = clampCount(field.count);
      });
    });
    return options;
  }

  /** Re-render from a mutated draft. Any edit makes it the user's, not detection's. */
  async #update(mutate) {
    const options = this.#syncValues();
    mutate(options);
    this.#draft = options;
    this.#suggested = false;
    return this.render();
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    // An abandoned draft must not come back when the dialog is opened on the next
    // creature; reopening always starts from what is stored.
    this.#draft = null;
  }

  async _prepareContext() {
    const actor = this.actor;
    const attacks = this.#attacks();
    const options = this.#options();
    const suggestion = actor ? suggestMultiattack(actor) : [];

    return {
      actor,
      attacks,
      hasAttacks: attacks.length > 0,
      // Re-reading the statblock is only worth a button once the editor is showing
      // something other than untouched detection output - before that it is a
      // no-op sitting next to the thing it would produce. After any edit it turns
      // into the way back, which is what it is for now that the editor prefills.
      suggestion: suggestion.length && !this.#suggested ? suggestion : null,
      // "Read from the statblock, not stored" - said only while there is something
      // to say it about.
      suggested: this.#suggested && options.length > 0,
      limits: CONFIG_LIMITS,
      options: options.map((option, o) => ({
        index: o,
        number: o + 1,
        parts: (option.parts ?? []).map((part, p) => ({
          index: p,
          count: part.count ?? 1,
          choices: attacks.map(row => ({
            key: row.key,
            label: row.detail ? `${row.name} (${row.detail})` : row.name,
            selected: row.key === part.key
          }))
        }))
      }))
    };
  }

  /* -------------------------------------------- */

  static async #onAddOption() {
    return this.#update(options => options.push({ parts: [] }));
  }

  static async #onRemoveOption(event, target) {
    const index = Number(target.dataset.option);
    return this.#update(options => options.splice(index, 1));
  }

  static async #onAddPart(event, target) {
    const index = Number(target.dataset.option);
    // A new row is seeded with the first attack rather than an empty key: the select
    // has no blank entry, so an empty key would display as the first attack anyway
    // and the draft would disagree with what the dialog shows.
    const first = this.#attacks()[0]?.key ?? "";
    return this.#update(options => {
      const option = options[index];
      if (option) option.parts = [...(option.parts ?? []), { key: first, count: 1 }];
    });
  }

  static async #onRemovePart(event, target) {
    const o = Number(target.dataset.option);
    const p = Number(target.dataset.part);
    return this.#update(options => options[o]?.parts?.splice(p, 1));
  }

  /** Back to the draft parsed out of the statblock. Never applied on its own. */
  static async #onUseSuggestion() {
    const actor = this.actor;
    if (!actor) return;
    this.#draft = suggestMultiattack(actor);
    this.#suggested = true;
    return this.render();
  }

  static async #onClearAll() {
    return this.#update(options => options.splice(0, options.length));
  }

  static async #onSubmit(event, form, formData) {
    const actor = this.actor;
    if (!actor) return;
    // Drop empty options and empty parts: a half-filled row is not a rule, and
    // storing it would make the economy think an alternative exists that allows
    // nothing at all. This is the one place emptiness is allowed to remove
    // something - while editing, an empty alternative has to survive (see #draft).
    const options = this.#syncValues()
      .map(option => ({
        parts: (option.parts ?? [])
          .filter(part => part.key)
          .map(part => ({ key: part.key, count: clampCount(part.count) }))
      }))
      .filter(option => option.parts.length);
    const config = { ...getActorConfig(actor) };
    if (options.length) config.multiattack = { options };
    else delete config.multiattack;
    // Saving IS the answer to the statblock's reading: it was on screen, prefilled,
    // and the player pressed Save on whatever they made of it. Recording that
    // reading as seen is what stops a deliberately hand-built Multiattack - or a
    // deliberately empty one - from raising the mark again the moment it is stored.
    config.seenMultiattackSuggestion = multiattackKey(suggestMultiattack(actor));
    await setActorConfig(actor, config);
    this.#draft = null;
    ui.notifications.info(game.i18n.format(
      `${MODULE_ID}.multiattack.${options.length ? "saved" : "cleared"}`, { name: actor.name }
    ));
  }
}

/* ---------------------------------------------- */

export function openMultiattack(actor) {
  const existing = foundry.applications.instances?.get("hudtra-multiattack");
  const app = existing instanceof MultiattackConfig ? existing : new MultiattackConfig();
  if (actor) app.selectActor(actor);
  return app.render({ force: true });
}
