import { MODULE_ID, CONFIG_LIMITS } from "./const.mjs";
import { collectConfigurable, suggestMultiattack } from "./actions.mjs";
import { configTarget, getActorConfig, setActorConfig } from "./config.mjs";

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

const numeric = (obj) => Object.entries(obj ?? {})
  .sort((a, b) => Number(a[0]) - Number(b[0]))
  .map(([, value]) => value);

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
   * The options being edited. Held here rather than read from the DOM on demand
   * because adding or removing a row re-renders, and a re-render would otherwise
   * throw away every number typed since the last save.
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

  /** Current state of the form, so structural edits keep what was typed. */
  #readForm() {
    if (!this.element) return this.#draft ?? [];
    const FDE = foundry.applications.ux?.FormDataExtended ?? FormDataExtended;
    const raw = foundry.utils.expandObject(new FDE(this.element).object);
    return numeric(raw.options).map(option => ({
      parts: numeric(option?.parts)
        .filter(part => part?.key)
        .map(part => ({
          key: part.key,
          count: Math.clamp(Math.floor(Number(part.count) || 1), 1, CONFIG_LIMITS.attacksPerAction.max)
        }))
    }));
  }

  /** Re-render from a mutated draft. */
  async #update(mutate) {
    const options = this.#readForm();
    mutate(options);
    this.#draft = options;
    return this.render();
  }

  async _prepareContext() {
    const actor = this.actor;
    const attacks = actor
      ? collectConfigurable(actor).filter(row => row.pool === "action" && row.attack)
      : [];
    const stored = actor ? getActorConfig(actor).multiattack?.options : null;
    const options = this.#draft ?? (Array.isArray(stored) ? foundry.utils.deepClone(stored) : []);
    const suggestion = actor ? suggestMultiattack(actor) : [];

    return {
      actor,
      attacks,
      hasAttacks: attacks.length > 0,
      suggestion: suggestion.length ? suggestion : null,
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
    return this.#update(options => {
      const option = options[index];
      if (option) option.parts = [...(option.parts ?? []), { key: "", count: 1 }];
    });
  }

  static async #onRemovePart(event, target) {
    const o = Number(target.dataset.option);
    const p = Number(target.dataset.part);
    return this.#update(options => options[o]?.parts?.splice(p, 1));
  }

  /** Take the draft parsed out of the statblock. Never applied on its own. */
  static async #onUseSuggestion() {
    const actor = this.actor;
    if (!actor) return;
    this.#draft = suggestMultiattack(actor);
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
    // nothing at all.
    const options = this.#readForm().filter(option => option.parts.length);
    const config = { ...getActorConfig(actor) };
    if (options.length) config.multiattack = { options };
    else delete config.multiattack;
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
