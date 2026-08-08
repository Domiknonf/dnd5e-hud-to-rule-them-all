import {
  MODULE_ID, CONFIGURABLE_POOLS, CONFIG_LIMITS, DEFAULT_ATTACKS_PER_ACTION,
  ASSIGNABLE_POOLS, RESOURCES, HIDDEN_ZONE
} from "./const.mjs";
import { guessAttacksPerAction, collectConfigurable } from "./actions.mjs";
import { configTarget, getActorConfig, setActorConfig } from "./config.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/**
 * PER-ACTOR CONFIGURATION, dialog layer. Storage lives in config.mjs; this file is
 * what the owner (or the GM) uses to fill it in.
 *
 * The detection in actions.mjs is NOT removed by any of this. It is demoted to a
 * suggestion: it seeds the zones below and still serves as the runtime fallback while
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
    position: { width: 820, height: 680 },
    form: { handler: HudConfig.#onSubmit, submitOnChange: false, closeOnSubmit: false },
    actions: {
      pickActor: HudConfig.#onPickActor,
      applyNotice: HudConfig.#onApplyNotice,
      dismissNotice: HudConfig.#onDismissNotice,
      toggleAttack: HudConfig.#onToggleAttack,
      toggleHidden: HudConfig.#onToggleHidden,
      resetEntry: HudConfig.#onResetEntry,
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

  /* -------------------------------------------- */
  /*  Zones                                       */
  /* -------------------------------------------- */

  /**
   * The zones and their tiles, in bar order. Zones are SEEDED BY DETECTION: an entry
   * nobody ever touched still sits where the module thinks it belongs, so this is a
   * correction surface, not a blank slate you have to fill in before the bar works.
   *
   * HIDDEN_ZONE collects two different things on purpose - what was explicitly hidden
   * and what detection drops anyway (out-of-combat activations like a 1-minute
   * ritual). Both answer the same question, "why is this not on my bar", and dragging
   * either one into a pool is how you overrule it.
   */
  #zonesFor(actor) {
    const zoneKeys = [...ASSIGNABLE_POOLS, "passive", HIDDEN_ZONE];
    const zones = new Map(zoneKeys.map(k => [k, []]));

    for (const row of collectConfigurable(actor)) {
      // row.pool is the EFFECTIVE pool - configuration already applied by
      // enumerateEntries - so a moved entry already sits in its new zone.
      let zone = row.hidden ? HIDDEN_ZONE : (row.pool ?? HIDDEN_ZONE);
      if (!zones.has(zone)) zone = HIDDEN_ZONE;
      zones.get(zone).push({
        key: row.key,
        name: row.name,
        detail: row.detail,
        img: row.img,
        sort: row.sort,
        attack: row.attack,
        attackOverridden: row.attackOverridden,
        hidden: row.hidden,
        // `sort` deliberately does NOT count: reordering one zone writes a position
        // onto every tile in it, and marking all of them would turn the whole zone
        // orange. The mark means "a rule was set", not "this was touched".
        overridden: row.poolOverridden || row.attackOverridden || row.hidden,
        showAttack: zone === "action"
      });
    }

    for (const tiles of zones.values()) {
      tiles.sort((a, b) => {
        const as = a.sort ?? Infinity;
        const bs = b.sort ?? Infinity;
        return as !== bs ? as - bs : a.name.localeCompare(b.name);
      });
    }

    return zoneKeys.map(key => ({
      key,
      label: game.i18n.localize(
        key === HIDDEN_ZONE ? `${MODULE_ID}.config.zones.hidden` : `${MODULE_ID}.pool.${key}`
      ),
      icon: key === HIDDEN_ZONE ? "fa-solid fa-eye-slash" : (RESOURCES[key]?.icon ?? "fa-solid fa-circle"),
      hint: game.i18n.localize(`${MODULE_ID}.config.zones.${key === HIDDEN_ZONE ? "hiddenHint" : "empty"}`),
      tiles: zones.get(key)
    }));
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
      zones: actor ? this.#zonesFor(actor) : [],
      limits: CONFIG_LIMITS
    };
  }

  /* -------------------------------------------- */
  /*  Drag and drop                               */
  /* -------------------------------------------- */

  /**
   * DOCUMENTED EXCEPTION to "no manual listeners", the second one in this codebase
   * after the HUD's auxclick handler. HTML5 drag events cannot be routed through
   * ApplicationV2's action dispatcher, which binds only click and contextmenu. These
   * four are delegated from the persistent root element and bound once.
   * @override
   */
  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    const el = this.element;
    el.addEventListener("dragstart", this.#onDragStart.bind(this));
    el.addEventListener("dragover", this.#onDragOver.bind(this));
    el.addEventListener("dragleave", this.#onDragLeave.bind(this));
    el.addEventListener("drop", this.#onDrop.bind(this));
  }

  #onDragStart(event) {
    const tile = event.target?.closest?.(".hudtra-tile");
    if (!tile) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", JSON.stringify({
      type: "hudtra-entry", key: tile.dataset.key
    }));
  }

  #onDragOver(event) {
    const zone = event.target?.closest?.(".hudtra-zone");
    if (!zone) return;
    event.preventDefault();
    zone.classList.add("drop-target");
  }

  #onDragLeave(event) {
    const zone = event.target?.closest?.(".hudtra-zone");
    // relatedTarget is where the pointer went; ignore moves between a zone's children.
    if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove("drop-target");
  }

  async #onDrop(event) {
    const zone = event.target?.closest?.(".hudtra-zone");
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove("drop-target");
    const actor = this.actor;
    if (!actor) return;

    let data = null;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
    if (!data) return;

    // Two sources: a tile already in the dialog, or an Item dragged off the sheet.
    const key = data.type === "hudtra-entry" ? data.key
      : data.type === "Item" ? await this.#keyForItem(actor, data.uuid)
      : null;
    if (!key) return;

    return this.#assign(actor, key, zone.dataset.zone, this.#insertionIndex(zone, event));
  }

  /**
   * Resolve an Item dropped from the character sheet to one configurable entry.
   * Rejects items belonging to somebody else, and items whose activities span several
   * pools - there the item is not one entry, and silently moving all of its halves is
   * exactly the behaviour the per-activity keys exist to prevent.
   */
  async #keyForItem(actor, uuid) {
    const item = await fromUuid(uuid).catch(() => null);
    if (!item) return null;
    if (configTarget(item.actor)?.uuid !== configTarget(actor)?.uuid) {
      ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.config.zones.foreignItem`));
      return null;
    }
    const rows = collectConfigurable(actor).filter(r => r.key === item.id || r.key.startsWith(`${item.id}:`));
    if (!rows.length) return null;
    if (rows.length > 1) {
      ui.notifications.warn(game.i18n.format(`${MODULE_ID}.config.zones.splitItem`, { name: item.name }));
      return null;
    }
    return rows[0].key;
  }

  /** Reading-order insertion point for a drop inside a wrapping tile grid. */
  #insertionIndex(zone, event) {
    const tiles = [...zone.querySelectorAll(".hudtra-tile")];
    for (let i = 0; i < tiles.length; i++) {
      const rect = tiles[i].getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) return i;
      if (event.clientY <= rect.bottom && event.clientX < rect.left + rect.width / 2) return i;
    }
    return tiles.length;
  }

  /**
   * Move an entry into a zone at a position, and persist both. Asks first when the
   * target disagrees with detection - that confirmation is the whole point of seeding
   * the zones from detection, since it turns a silent override into a decision.
   */
  async #assign(actor, key, zone, index) {
    const rows = collectConfigurable(actor);
    const row = rows.find(r => r.key === key);
    if (!row) return;
    const auto = row.auto.pool;

    // Being shown as passive is NOT what decides this - a passive feat that carries
    // activities (Cunning Strike) can perfectly well be put on the bar. What decides
    // it is whether there is anything to fire at all.
    if (ASSIGNABLE_POOLS.includes(zone) && !row.usable) {
      return ui.notifications.warn(game.i18n.format(`${MODULE_ID}.config.zones.notUsable`, { name: row.name }));
    }
    if (zone === "passive" && auto !== "passive") {
      return ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.config.zones.notPassive`));
    }

    if (zone !== HIDDEN_ZONE && zone !== "passive" && auto && zone !== auto) {
      const esc = Handlebars.escapeExpression;
      const ok = await DialogV2.confirm({
        window: { title: game.i18n.localize(`${MODULE_ID}.config.zones.confirmTitle`) },
        content: `<p>${game.i18n.format(`${MODULE_ID}.config.zones.confirmBody`, {
          name: esc(row.name),
          target: esc(game.i18n.localize(`${MODULE_ID}.pool.${zone}`)),
          detected: esc(game.i18n.localize(`${MODULE_ID}.pool.${auto}`))
        })}</p>`,
        modal: true,
        rejectClose: false
      }).catch(() => false);
      if (!ok) return;
    }

    const config = getActorConfig(actor);
    const entries = foundry.utils.deepClone(config.entries ?? {});

    // A button can cover several activities (a Planetar's Divine Aid groups three
    // at-will spells into one), so the rule goes on every one of them - otherwise
    // the group would come apart the moment it moved.
    for (const k of row.keys) {
      const rule = { ...(entries[k] ?? {}) };
      if (zone === HIDDEN_ZONE) rule.hidden = true;
      else {
        delete rule.hidden;
        // Dropping something back where detection wanted it removes the rule instead
        // of pinning the same value - otherwise "auto" could never be restored.
        if (zone === auto || zone === "passive") delete rule.pool;
        else rule.pool = zone;
      }
      entries[k] = rule;
    }

    // Renumber the target zone so the entry sits where it was let go. Computed from
    // the CURRENT layout: the entry either was already in this zone (a reorder) or
    // was not (an insert), and both fall out of the same two lines.
    const tiles = this.#zonesFor(actor).find(z => z.key === zone)?.tiles ?? [];
    const from = tiles.findIndex(t => t.key === key);
    const ordered = tiles.map(t => t.key).filter(k => k !== key);
    // The index came from the rendered grid, which still counted the dragged tile,
    // so moving an entry further down its own zone has to shift back by one.
    const at = from >= 0 && from < index ? index - 1 : index;
    ordered.splice(Math.clamp(at, 0, ordered.length), 0, key);

    const byKey = new Map(rows.map(r => [r.key, r]));
    ordered.forEach((k, i) => {
      for (const member of byKey.get(k)?.keys ?? [k]) {
        entries[member] = { ...(entries[member] ?? {}), sort: i };
      }
    });

    await this.#write(actor, { ...config, entries });
  }

  /** Apply a change to every config key one button covers. */
  async #mutateEntry(key, mutate) {
    const actor = this.actor;
    if (!actor || !key) return;
    const row = collectConfigurable(actor).find(r => r.key === key);
    if (!row) return;
    const config = getActorConfig(actor);
    const entries = { ...(config.entries ?? {}) };
    for (const k of row.keys) entries[k] = mutate({ ...(entries[k] ?? {}) }, row);
    return this.#write(actor, { ...config, entries });
  }

  /** Persist, dropping rules that no longer say anything. */
  async #write(actor, config) {
    const entries = {};
    for (const [key, rule] of Object.entries(config.entries ?? {})) {
      const kept = {};
      if (rule.pool) kept.pool = rule.pool;
      if (typeof rule.attack === "boolean") kept.attack = rule.attack;
      if (rule.hidden === true) kept.hidden = true;
      if (Number.isFinite(rule.sort)) kept.sort = rule.sort;
      if (Object.keys(kept).length) entries[key] = kept;
    }
    const next = { ...config };
    if (Object.keys(entries).length) next.entries = entries;
    else delete next.entries;
    await setActorConfig(actor, next);
    return this.render();
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onSubmit(event, form, formData) {
    const actor = this.actor;
    if (!actor) return;
    const raw = foundry.utils.expandObject(formData.object);
    const previous = getActorConfig(actor);
    const config = {};

    // The write replaces the whole object (see setActorConfig), so anything the form
    // does not render has to be carried across by hand. The zones are not form
    // fields - they save on every drop - so losing these two here would wipe every
    // rule the moment somebody edited a number.
    if (previous.seenAttackSuggestion !== undefined) {
      config.seenAttackSuggestion = previous.seenAttackSuggestion;
    }
    if (previous.entries) config.entries = previous.entries;

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

  /**
   * Flip whether this entry consumes one attack inside the Attack action. Stored as
   * an explicit boolean, but cleared again when it would only repeat what detection
   * already says - so the button is a two-state toggle to use and tri-state to store.
   */
  static async #onToggleAttack(event, target) {
    const key = target.closest(".hudtra-tile")?.dataset.key;
    return this.#mutateEntry(key, (rule, row) => {
      const next = !row.attack;
      if (next === row.auto.attack) delete rule.attack;
      else rule.attack = next;
      return rule;
    });
  }

  static async #onToggleHidden(event, target) {
    const key = target.closest(".hudtra-tile")?.dataset.key;
    return this.#mutateEntry(key, (rule, row) => {
      if (row.hidden) delete rule.hidden;
      else rule.hidden = true;
      return rule;
    });
  }

  /** Drop every rule for one entry, back to whatever detection says. */
  static async #onResetEntry(event, target) {
    const key = target.closest(".hudtra-tile")?.dataset.key;
    return this.#mutateEntry(key, () => ({}));
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
