import {
  MODULE_ID, RESOURCES, POOL_ORDER, SECTIONS, SPELL_PIP_LIMIT,
  GRID_ROWS, GRID_TABS, ALL_TAB, GRID_CELL_LIMIT, DEBOUNCE_MS, DESC_CARD, DEATH_SAVE_PIPS,
  HUD_SCALE
} from "./const.mjs";
import {
  getEconomy, resetTurn, remainingOf, getAttacksPerAction, combatantFor, spend,
  refund, poolMax, blockedPools, blockingConditions, coupledOutPools, coupledPools,
  isTracked
} from "./economy.mjs";
import { collectActions } from "./actions.mjs";
import { spellSlots } from "./spells.mjs";
import { openConfig, attackNotice } from "./config-app.mjs";
import { configTarget, setEntryOrder, setEntryHidden } from "./config.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/**
 * The hover card's fixed wording, localized once instead of per row per entry per
 * render - a caster's bar is sixty-odd tooltips with up to five rows each, and every
 * one of those labels is the same six strings. Built lazily because i18n is not ready
 * at import time, and never rebuilt: Foundry requires a reload to change language.
 */
let ttLabels = null;
function tooltipLabels() {
  if (ttLabels) return ttLabels;
  const esc = Handlebars.escapeExpression;
  const of = (key) => esc(game.i18n.localize(`${MODULE_ID}.tooltip.${key}`));
  return (ttLabels = {
    range: of("range"), target: of("target"), damage: of("damage"),
    uses: of("uses"), alsoIn: of("alsoIn"), middleClick: of("middleClick")
  });
}

/**
 * BG3-style hover card, injected via data-tooltip-html (core cleans the HTML with
 * foundry.utils.cleanHTML before display). Pure presentation: big icon, name, a
 * meta line (pool + spell level) and one row per known detail. All dynamic values
 * are escaped - item names are user content.
 */
function tooltipFor(entry, poolLabel) {
  const esc = Handlebars.escapeExpression;
  const labels = tooltipLabels();
  const img = entry.img ? `<img src="${esc(entry.img)}" alt="">` : "";
  const spellLevel = entry.itemType === "spell" && entry.level != null
    ? game.i18n.localize(CONFIG.DND5E?.spellLevels?.[entry.level] ?? "") : "";
  // The activity's own name leads the meta line on a split button: it is the one
  // word that tells this half of the item from the other one, which otherwise shares
  // its name and its art.
  const meta = [entry.subtitle, poolLabel, spellLevel].filter(Boolean).map(esc).join(" &middot; ");
  const rows = [];
  const row = (key, value) => rows.push(
    `<div class="hudtra-tt-row"><dt>${labels[key]}</dt><dd>${esc(value)}</dd></div>`
  );
  if (entry.details?.range) row("range", entry.details.range);
  if (entry.details?.target) row("target", entry.details.target);
  if (entry.details?.damage) row("damage", entry.details.damage);
  if (entry.uses) row("uses", `${entry.uses.value}/${entry.uses.max}`);
  // Answers "why is this on my bar twice" in the one place with room for it.
  if (entry.otherPools?.length) row("alsoIn", entry.otherPools.join(", "));
  if (entry.attacksBadge) rows.push(`<div class="hudtra-tt-row"><dd class="hudtra-tt-attacks">${esc(entry.attacksBadge.hint)}</dd></div>`);
  return `<div class="hudtra-tt">`
    + `<header>${img}<div><span class="hudtra-tt-name">${esc(entry.name)}</span>`
    + (meta ? `<span class="hudtra-tt-meta">${meta}</span>` : "") + `</div></header>`
    + (rows.length ? `<dl class="hudtra-tt-rows">${rows.join("")}</dl>` : "")
    + (entry.description ? `<p class="hudtra-tt-hint">${labels.middleClick}</p>` : "")
    + `</div>`;
}

/**
 * dnd5e's own item card - the one the character sheet shows on hover and pins on a
 * middle click, complete with its property pills. Returned as raw content plus the
 * classes it wants on the tooltip element, because that is what the pin needs.
 *
 * The fallback is a plainly enriched description, for anything whose data model has
 * no richTooltip(); it carries its own class so our CSS can make it presentable
 * without touching dnd5e's card.
 */
async function descriptionCard(uuid) {
  const doc = await fromUuid(uuid).catch(() => null);
  const item = doc?.item ?? doc;   // an Activity uuid resolves to its parent item
  if (!item) return null;

  if (typeof item.system?.richTooltip === "function") {
    try {
      const card = await item.system.richTooltip();
      return {
        html: card.content,
        classes: card.classes?.length ? card.classes : ["dnd5e2", "dnd5e-tooltip", "item-tooltip"]
      };
    } catch (err) {
      console.warn(`${MODULE_ID} | richTooltip failed, falling back to raw description`, err);
    }
  }

  const esc = Handlebars.escapeExpression;
  const TE = foundry.applications.ux?.TextEditor?.implementation ?? TextEditor;
  const enriched = await TE.enrichHTML(item.system?.description?.value ?? "", {
    relativeTo: item,
    rollData: item.getRollData?.() ?? {}
  });
  return {
    html: `<div class="hudtra-desc-body"><img src="${esc(item.img)}" alt="">`
      + `<div class="hudtra-desc-text">${enriched}</div></div>`,
    classes: ["hudtra-desc-plain"]
  };
}

/* ---------------------------------------------- */
/*  Spell strip                                    */
/* ---------------------------------------------- */

/**
 * The highest spell level this creature can still pay for, or null when it has no slot
 * pools at all and nothing can be concluded from them.
 *
 * A ceiling rather than a per-level check, because upcasting exists: a 4th-level slot
 * casts a 1st-level spell, so what matters is whether ANY slot at or above the spell's
 * own level is left. Pact slots count, at their own level.
 *
 * -1 means "there are pools and every one of them is empty" - that greys every leveled
 * spell, which is right, and is a different answer from null, which greys nothing.
 */
function highestCastable(rows) {
  if (!rows.length) return null;
  return rows.reduce((best, row) => (row.value > 0 && row.level > best ? row.level : best), -1);
}

/**
 * The spell slots in the resource cluster: one row per level this creature either has
 * slots for or has spells for, plus a Pact Magic row.
 *
 * A READOUT, not a control. These rows used to filter the bar down to one level, and
 * that was answering the wrong question: what you want to know mid-turn is "can I still
 * cast this", so the bar now says so directly by greying out what no slot can pay for
 * (see highestCastable). A filter made you ask the question, click, and then undo the
 * click; the greying just tells you.
 *
 * ONE ROW PER SLOT POOL, and nothing else. Levels the creature knows spells at but has
 * no slots for used to get a row too, marked "no slots at this level" - which was noise
 * at best and a lie at worst: a warlock has no `spell3` pool and can absolutely cast a
 * 3rd-level spell, out of the Pact Magic row sitting right below it. Nothing is lost by
 * dropping those rows, because whether a spell is castable is answered on the spell
 * itself now, by the greying. Cantrips go the same way: at-will, no pool, no row.
 *
 * A pool with slots but no spell on the bar still shows - the slots are worth seeing,
 * and a scroll or a hidden entry may well spend them.
 *
 * Takes the rows rather than the actor, so one spellSlots() read serves both this and
 * highestCastable above instead of each walking system.spells for itself.
 */
function spellBarFor(rows) {
  if (!rows.length) return null;
  const leveled = rows.filter(r => !r.pact).sort((a, b) => a.level - b.level);
  const pact = rows.find(r => r.pact) ?? null;

  /**
   * One pip per slot, filled while it is still there. A number answers "how many"
   * only after you read it; four dots answer it at a glance, which is the whole
   * question this row exists for. Past SPELL_PIP_LIMIT it goes back to being a
   * number, because a row of pips that has to be counted is just a worse number.
   */
  const slotsOf = (row) => row.max > SPELL_PIP_LIMIT
    ? { pips: null, slots: `${row.value}/${row.max}` }
    : { pips: Array.fromRange(row.max).map(i => ({ spent: i >= row.value })), slots: "" };

  const levels = leveled.map(row => {
    // dnd5e's own level names, localized by the system - "1st Level", "2nd Level", …
    const label = game.i18n.localize(CONFIG.DND5E?.spellLevels?.[row.level] ?? "") || String(row.level);
    return {
      level: row.level,
      // Its own numeral - short enough to stay legible at the bar's smallest scale.
      short: String(row.level),
      ...slotsOf(row),
      empty: row.value <= 0,
      tooltip: `${label} · ${game.i18n.format(`${MODULE_ID}.spells.slotsLeft`, row)}`
    };
  });

  return {
    levels,
    pact: pact && {
      short: game.i18n.localize(`${MODULE_ID}.spells.pactShort`),
      ...slotsOf(pact),
      empty: pact.value <= 0,
      tooltip: `${game.i18n.format(`${MODULE_ID}.spells.pactLabel`, pact)} · `
        + game.i18n.format(`${MODULE_ID}.spells.slotsLeft`, pact)
    }
  };
}

/**
 * One row of death-save pips, filled up to `n`. Same reasoning as the spell slots:
 * three dots answer "how close is this" without being read, which at 0 HP is the only
 * way anybody is going to read it.
 */
function deathPips(n) {
  const filled = Math.clamp(Number(n) || 0, 0, DEATH_SAVE_PIPS);
  return Array.fromRange(DEATH_SAVE_PIPS).map(i => ({ on: i < filled }));
}

/* ---------------------------------------------- */
/*  The slot grid                                  */
/* ---------------------------------------------- */

/**
 * BG3's model, for every creature: ONE grid of slots rather than a column per pool,
 * with the pool drawn as a marker on each slot. The
 * empty slots are painted by CSS rather than rendered, so the field is always a full
 * rectangle at any width without anybody counting columns.
 *
 * Categories become tabs above the grid instead of chips inside every group header.
 * Passives get a tab of their own and are OUT of the default grid: they are not
 * actions and have no business filling hotbar slots, but they are still the answer to
 * "what does this creature have".
 *
 * The order is pool first, then whatever the sort settings and the `sort` rule
 * produced - so a creature's attacks still lead, and the gear dialog still decides
 * inside a pool, exactly as in the grouped bar.
 */
function gridFor(buckets, category) {
  const showing = category ?? null;
  const entries = [];
  for (const key of POOL_ORDER) {
    // Passives only ever appear on their own tab, never mixed into the action grid.
    if (key === "passive" ? showing !== "passive" : showing === "passive") continue;
    for (const entry of buckets[key] ?? []) {
      if (showing && showing !== "passive" && entry.section !== showing) continue;
      entries.push(entry);
    }
  }
  return arranged(entries);
}

/**
 * Put a list of buttons in the order the player arranged them. `sort` is a GLOBAL
 * index (see config.setEntryOrder), which is what lets an icon dropped on an icon
 * from another pool actually trade places with it - in the grid, pool order is only
 * the seed. Array#sort is stable, so anything with no position keeps the pool-first
 * order it arrived in and lands after the arranged ones.
 */
function arranged(entries) {
  return entries.sort((a, b) => (a.sort ?? Infinity) - (b.sort ?? Infinity));
}

/**
 * Every button on this creature's bar in the order it is drawn, packed. This is what
 * the GM's pool columns use: there is no field to leave a gap in there, so a position
 * is a rank and nothing else.
 */
function barButtons(buckets) {
  const all = [];
  for (const key of POOL_ORDER) for (const entry of buckets[key] ?? []) all.push(entry);
  return arranged(all);
}

/** The grid's height in rows, clamped - the setting is a number a user could edit. */
function gridRowCount() {
  return Math.clamp(
    Number(game.settings.get(MODULE_ID, "gridRows")) || GRID_ROWS.default,
    GRID_ROWS.min, GRID_ROWS.max
  );
}

/**
 * THE GRID AS CELLS, which is what makes an empty slot a place you can drop on.
 *
 * `sort` is read here as an absolute cell number rather than as a rank: cell 7 is
 * cell 7 whether or not cells 4 to 6 hold anything. That is the whole difference
 * between "the icons keep an order" and "the icons keep a place" - a gap you left as
 * a separator survives, and dropping something two columns to the right leaves it
 * two columns to the right instead of pulling it back against the others.
 *
 * Consequences that fall out of it, and are all wanted:
 * - Hiding a button leaves its cell empty. Nothing slides up, because nothing in an
 *   arranged grid should move on its own.
 * - A button with no cell yet (a new item, or a fresh character) goes after the last
 *   occupied one, never into a gap somebody made on purpose.
 * - Two buttons claiming the same cell cannot both have it: the second one is treated
 *   as having none. That is only reachable from a stale config, and it resolves
 *   itself the moment anything is dragged.
 *
 * The empty cells ARE rendered here, unlike the painted field behind them (see the
 * CSS): only up to the end of the arrangement plus one spare column, so there is
 * always somewhere new to drop without putting the whole rectangle in the DOM.
 */
function gridCells(entries, rows) {
  // How far right this grid may run. GRID_CELL_LIMIT is the guard against a nonsense
  // number in a hand-edited flag asking for a hundred thousand elements; it never
  // costs a button, because a creature with more entries than that raises its own
  // ceiling - losing an icon would be a far worse answer than a wide grid.
  const limit = Math.max(GRID_CELL_LIMIT, entries.length + rows);
  const placed = new Map();
  const floating = [];
  for (const entry of entries) {
    const cell = Number.isFinite(entry.sort) ? entry.sort : -1;
    if (cell < 0 || cell >= limit || placed.has(cell)) floating.push(entry);
    else placed.set(cell, entry);
  }

  // After the last occupied cell, never into a gap somebody left on purpose - unless
  // the end is full up, where the first free cell beats not being drawn at all.
  let next = placed.size ? Math.max(...placed.keys()) + 1 : 0;
  for (const entry of floating) {
    while (placed.has(next)) next++;
    if (next >= limit) { next = 0; while (placed.has(next)) next++; }
    placed.set(next++, entry);
  }

  const last = placed.size ? Math.max(...placed.keys()) : -1;
  const total = Math.min(Math.ceil((last + 1) / rows) * rows + rows, limit);
  const cells = [];
  for (let i = 0; i < total; i++) cells.push(placed.get(i) ?? { empty: true, cell: i });
  return cells;
}

/**
 * The tab strip: every category this creature actually has something in, led by "All".
 *
 * That first tab is the filter's off switch made visible. Clearing the filter was
 * always possible - clicking the lit tab again does it - but nothing on the strip said
 * so, and a bar narrowed to Weapons looks exactly like a bar that only has weapons.
 * It carries no state of its own: "everything" IS the null category, so it lights up
 * by itself whenever a tab is clicked off.
 */
function tabsFor(buckets, category) {
  const counts = new Map();
  for (const [key, bucket] of Object.entries(buckets)) {
    for (const entry of bucket) {
      const tab = key === "passive" ? "passive" : entry.section;
      counts.set(tab, (counts.get(tab) ?? 0) + 1);
    }
  }
  const tabs = GRID_TABS
    .filter(key => counts.has(key))
    .map(key => {
      const label = game.i18n.localize(
        key === "passive" ? `${MODULE_ID}.pool.passive` : `${MODULE_ID}.section.${key}`
      );
      const active = category === key;
      return {
        key, label,
        count: counts.get(key),
        active,
        icon: key === "passive" ? RESOURCES.passive.icon : (SECTIONS[key]?.icon ?? "fa-solid fa-circle"),
        tooltip: game.i18n.format(`${MODULE_ID}.tab.${active ? "off" : "on"}`, { label })
      };
    });
  if (!tabs.length) return tabs;

  // Counts what All actually shows, which is everything EXCEPT the passives - they
  // are not actions and stay on their own tab (see gridFor).
  const total = tabs.reduce((n, tab) => tab.key === "passive" ? n : n + tab.count, 0);
  tabs.unshift({
    key: ALL_TAB,
    label: game.i18n.localize(`${MODULE_ID}.tab.all`),
    count: total,
    active: !category,
    icon: "fa-solid fa-border-all",
    tooltip: game.i18n.localize(`${MODULE_ID}.tab.allHint`)
  });
  return tabs;
}

export class CombatHUD extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "hud-to-rule-them-all",
    classes: ["hudtra"],
    tag: "section",
    window: { frame: false, positioned: false },
    actions: {
      use: CombatHUD.#onUse,
      describe: CombatHUD.#onShowDescription,
      collapse: CombatHUD.#onCollapse,
      toggleCategory: CombatHUD.#onToggleCategory,
      rows: CombatHUD.#onRows,
      portrait: CombatHUD.#onPortrait,
      config: CombatHUD.#onConfig,
      // The ONE action here that needs the right mouse button as well. An action
      // declared as a bare function answers to button 0 only - ApplicationV2 defaults
      // `buttons` to [0], so the contextmenu listener it binds never reached this
      // handler and right-clicking a pool did nothing at all. Declaring the buttons is
      // the supported way to opt in (foundryvtt/foundryvtt#10704).
      adjustPool: { handler: CombatHUD.#onAdjustPool, buttons: [0, 2] },
      reset: CombatHUD.#onReset,
      endTurn: CombatHUD.#onEndTurn
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/hud.hbs` }
  };

  /** Which combatant the HUD is showing. Defaults to the active combatant. */
  #combatantId = null;

  /**
   * The description cards currently pinned, by the uuid they were opened from. Core
   * owns the elements (they live in its tooltip layer, outside this application's
   * root and outside its re-renders); this is only what is needed to toggle one off
   * again and to clear them all when the bar changes creature.
   */
  #pinned = new Map();

  /**
   * Category tab the grid is narrowed to (a SECTIONS key, or
   * "passive"), or null for "everything that is an action".
   *
   * Instance state, deliberately NOT persisted: a fold says "I never want to look at
   * this", a tab says "right now I am looking for a weapon". Coming back next session
   * with half your bar hidden would be a bug, not a memory.
   */
  #category = null;

  /** Who the bar showed last render, so a change can close a stale description. */
  #shownActorUuid = null;

  /**
   * Arranging state, all of it alive only between dragstart and dragend: the key of
   * the button being dragged, the slot currently lit up under it, and whether the
   * user may write config for the creature shown at all (the same answer the gear
   * button uses). `#dragKey` doubles as "this drag is still unhandled" - the drop
   * clears it, so dragend can tell a swap from a release outside the bar.
   */
  #dragKey = null;
  #dragGroup = null;
  #dropSlot = null;
  #editable = false;

  /**
   * Whether the bar is slid down out of view. Tracked here AND as a CSS class on
   * the persistent root element: toggling the class without a re-render is what
   * makes the slide transition actually animate, while the field survives future
   * re-renders (which rebuild the frame) and re-applies the state in _onRender.
   */
  #collapsed = false;

  get combatant() {
    const combat = game.combat;
    if (!combat) return null;
    return combat.combatants.get(this.#combatantId) ?? combat.combatant ?? null;
  }

  /**
   * Whose abilities the bar shows. Null means there is nothing to show and the bar
   * closes entirely.
   *
   * A SELECTED TOKEN ALWAYS WINS, for everyone - clicking a token is a deliberate
   * "show me this one", and deselecting hands the bar back to the fallback. Only
   * the fallback differs, and that difference matters:
   *
   * - The GM runs the encounter, so theirs is whoever is currently acting.
   * - A PLAYER falls back to their OWN character, never to the acting creature.
   *   Following the turn pointer meant that while a goblin acted, every player's
   *   bar filled up with that goblin - useless during someone else's turn, and it
   *   printed the monster's entire ability list into their UI. It also hid their
   *   own reaction pips at exactly the moment a reaction is worth spending.
   */
  get subjectActor() {
    const controlled = canvas?.tokens?.controlled?.find(t => t.actor?.isOwner)?.actor;
    if (controlled) return controlled;

    if (game.user.isGM) {
      const acting = game.combat?.started ? this.combatant?.actor : null;
      return acting ?? game.user.character ?? null;
    }

    // A player without an assigned character still gets their own creature if one
    // of theirs is in the fight (a summon, a swapped-in NPC).
    return game.user.character
      ?? game.combat?.combatants.find(c => c.actor?.isOwner)?.actor
      ?? null;
  }

  /**
   * The subject's OWN combatant, not the acting one. This is what makes the economy
   * row belong to the creature in the bar - otherwise a player would see their own
   * character wearing the active monster's pips.
   */
  get subjectCombatant() {
    return this.#combatantOf(this.subjectActor);
  }

  /**
   * The same answer for an actor the caller has already resolved. subjectActor is a
   * search (controlled tokens, then the fallback chain), and _prepareContext needs
   * both halves - going through the getter again ran that search twice per render.
   */
  #combatantOf(actor) {
    if (!game.combat?.started) return null;
    return combatantFor(actor);
  }

  get hasSubject() {
    return !!this.subjectActor;
  }

  setCombatant(id) {
    this.#combatantId = id;
    return this.render();
  }

  /**
   * Programmatic slide, used when an encounter starts or ends. Same two-part state
   * as the handle itself: the field survives re-renders, the class drives the
   * transition. Safe before the first render - `element` is null until then.
   */
  collapse(state = true) {
    if (state) this.#unpinAll();
    this.#collapsed = state;
    this.element?.classList.toggle("collapsed", state);
  }

  /**
   * DOCUMENTED EXCEPTION to the "declarative click handling only" convention:
   * ApplicationV2's action dispatcher binds only "click" and "contextmenu", so a
   * middle click (which fires "auxclick", button 1) can never reach a declared
   * action. This single delegated listener routes middle clicks on action slots
   * into the same static-handler pattern everything else uses. The root element
   * survives re-renders, so binding once on first render is enough.
   * @override
   */
  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    this.element.addEventListener("auxclick", event => {
      if (event.button !== 1) return;
      const target = event.target?.closest?.(".hudtra-slot[data-uuid]");
      if (!target) return;
      event.preventDefault();
      // Core's own middle-click behaviour is "pin the active tooltip as a clone"
      // (TooltipManager#_onLockTooltip, on pointerup - which has already fired by
      // the time auxclick arrives). That pins the BAR'S hover card, which is the
      // stat line, not the description: dismiss it and pin the real card instead.
      // Same mechanism either way, so what ends up on screen is what the character
      // sheet's middle click produces.
      for (const el of document.querySelectorAll(".locked-tooltip.hudtra-tooltip")) {
        game.tooltip?.dismissLockedTooltip?.(el);
      }
      CombatHUD.#onShowDescription.call(this, event, target);
    });

    // DOCUMENTED EXCEPTION, the same one config-app.mjs makes and for the same
    // reason: HTML5 drag events cannot be routed through ApplicationV2's action
    // dispatcher, which binds click and contextmenu only. Four listeners, delegated
    // from the persistent root and bound once. No dragleave: dragover fires for the
    // frame around the slots too, which is where the highlight is cleared, and
    // dragend clears whatever is left when the pointer leaves the bar entirely.
    this.element.addEventListener("dragstart", this.#onSlotDragStart.bind(this));
    this.element.addEventListener("dragover", this.#onSlotDragOver.bind(this));
    this.element.addEventListener("drop", this.#onSlotDrop.bind(this));
    this.element.addEventListener("dragend", this.#onSlotDragEnd.bind(this));
  }

  /* -------------------------------------------- */
  /*  Arranging                                    */
  /* -------------------------------------------- */

  /** The slot lit up as the drop target, or null to clear it. */
  #markDropSlot(slot) {
    if (this.#dropSlot === slot) return;
    this.#dropSlot?.classList.remove("drop-target");
    slot?.classList.add("drop-target");
    this.#dropSlot = slot ?? null;
  }

  #onSlotDragStart(event) {
    const slot = event.target?.closest?.(".hudtra-slot[data-key]");
    if (!slot) return;
    // Nobody who cannot write the config gets to start the gesture: the confirmation
    // at the end of it would promise something the write then refuses.
    if (!this.#editable) return event.preventDefault();
    this.#dragKey = slot.dataset.key;
    // A swap only ever happens WITHIN one rendered group. In the grid that is
    // no limit at all - the whole bar is one group, which is what lets an icon trade
    // places with one from another pool. In the GM layout the groups are the pool
    // columns, and a swap across two of them would move nothing anybody can see,
    // because that bar orders by pool first. Refusing it says so; doing it silently
    // would look broken.
    this.#dragGroup = slot.closest(".hudtra-group")?.dataset.group ?? null;
    event.dataTransfer.effectAllowed = "move";
    // A type nothing else understands. The canvas and the macro bar both read this
    // payload on drop, so a miss lands nowhere rather than somewhere surprising.
    event.dataTransfer.setData("text/plain", JSON.stringify({
      type: "hudtra-slot", key: this.#dragKey
    }));
    slot.classList.add("dragging");
  }

  #onSlotDragOver(event) {
    if (!this.#dragKey) return;
    const slot = event.target?.closest?.(".hudtra-slot");
    // An occupied slot takes the drop unless it is the one being dragged; an empty
    // cell always does. Both only within the group the drag started in.
    const takes = !!slot
      && (slot.dataset.key ? slot.dataset.key !== this.#dragKey : slot.dataset.cell !== undefined)
      && (slot.closest(".hudtra-group")?.dataset.group ?? null) === this.#dragGroup;
    this.#markDropSlot(takes ? slot : null);
    if (!this.#dropSlot) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  /**
   * Icon onto icon: the two trade places, wherever on the bar they sit. Icon onto an
   * empty cell of the grid: it moves there and leaves its own cell empty, which is
   * what lets a player put space between two groups of icons.
   */
  async #onSlotDrop(event) {
    const from = this.#dragKey;
    if (!from) return;
    // Ours from here on, whatever it landed on inside the bar: the browser must not
    // also do whatever it does with a dropped payload.
    event.preventDefault();
    const slot = event.target?.closest?.(".hudtra-slot");
    const to = slot?.dataset.key ?? null;
    const cell = slot?.dataset.cell !== undefined ? Number(slot.dataset.cell) : null;
    // Cleared BEFORE the await: this drag is handled either way, and dragend (which
    // fires while the write is still in flight) must not offer to hide it as well.
    this.#dragKey = null;
    this.#dragGroup = null;
    this.#markDropSlot(null);
    const actor = this.subjectActor;
    if (!actor || to === from) return;

    const places = this.#placement(actor, from);
    const dragged = places.findIndex(entry => entry?.key === from);
    if (dragged < 0) return;

    if (to !== null) {
      const target = places.findIndex(entry => entry?.key === to);
      if (target < 0) return;
      [places[dragged], places[target]] = [places[target], places[dragged]];
    } else if (Number.isInteger(cell) && cell >= 0 && cell < places.length) {
      // The cell is empty by construction - only empty ones carry data-cell.
      places[cell] = places[dragged];
      places[dragged] = null;
    } else return;

    // Everything in that run is written, not just what moved: a position only means
    // something next to the others, and this is the one place they are all in hand.
    return setEntryOrder(actor, places);
  }

  /**
   * The run of positions one drag may rearrange, as an array whose INDEX is the
   * position. Which run it is depends on what was picked up, and the three cases are
   * the three things a position can mean on this bar:
   *
   * - the grid: absolute cells, gaps and all (see gridCells)
   * - the passives of that grid: their tab is a packed list, so a plain rank
   * - the GM's pool columns: the whole bar, packed, a plain rank
   *
   * Always built unfiltered: a category tab shows a subset, and renumbering a subset
   * would scramble everything it hides.
   */
  #placement(actor, key) {
    const buckets = collectActions(actor);
    // Passives are never IN the grid (gridFor keeps them on their own tab), so they
    // keep a run of their own - and stay out of the grid's cell numbering, where they
    // would show up as holes nobody can fill.
    if ((buckets.passive ?? []).some(entry => entry.key === key)) return arranged([...buckets.passive]);
    return gridCells(gridFor(buckets, null), gridRowCount());
  }

  /**
   * Let go outside the bar: offer to take the button off it. Hiding is exactly what
   * the gear dialog's "not on the bar" zone does, and that zone is also the way back.
   */
  async #onSlotDragEnd(event) {
    const key = this.#dragKey;
    this.#dragKey = null;
    this.#dragGroup = null;
    this.#markDropSlot(null);
    for (const el of this.element.querySelectorAll(".hudtra-slot.dragging")) {
      el.classList.remove("dragging");
    }
    // A swap already consumed this drag, or it was never ours.
    if (!key) return;
    // Escape reports no position at all. Only a real release counts as "out".
    if (!event.clientX && !event.clientY) return;
    const rect = this.element.querySelector(".hudtra-frame")?.getBoundingClientRect();
    if (!rect) return;
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (inside) return;

    const actor = this.subjectActor;
    const button = actor ? barButtons(collectActions(actor)).find(b => b.key === key) : null;
    if (!button) return;
    // On a split button the activity's own name is the only thing telling it from the
    // item's other half, so the question has to carry it - and only this half is hidden.
    const name = button.subtitle ? `${button.name} (${button.subtitle})` : button.name;
    const ok = await DialogV2.confirm({
      window: { title: game.i18n.localize(`${MODULE_ID}.hide.title`) },
      content: `<p>${game.i18n.format(`${MODULE_ID}.hide.body`, {
        name: Handlebars.escapeExpression(name)
      })}</p><p class="hint">${game.i18n.localize(`${MODULE_ID}.hide.hint`)}</p>`,
      modal: true,
      rejectClose: false
    }).catch(() => false);
    if (!ok) return;
    return setEntryHidden(actor, button.keys, true);
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    this.element.classList.toggle("collapsed", this.#collapsed);
  }

  /* -------------------------------------------- */
  /*  Pinned descriptions                          */
  /* -------------------------------------------- */

  /**
   * Pin the description card beside a slot, or take it away again if that slot's card
   * is already pinned.
   *
   * THIS IS CORE'S OWN PIN, not a panel of ours: `TooltipManager#lockTooltip` clones
   * the live tooltip into a `.locked-tooltip` that outlives the hover, which is exactly
   * what a middle click on the character sheet does. Two things follow, and both are
   * the point of doing it this way: the card is dnd5e's own (same markup, same classes,
   * same CSS as the sheet's), and it floats in core's tooltip layer, so it is never
   * clipped by the bar and never covered by a sheet.
   *
   * The bar's own hover card is pinned by core too - the middle click that gets here
   * already pinned it on pointerup - which is why the caller dismisses that first.
   */
  async #pinDescription(slot) {
    const uuid = slot?.dataset.uuid;
    const tips = game.tooltip;
    if (!uuid || !tips) return;
    // A second middle click on the same slot takes the card away: the gesture that
    // opened it is the first way back, clicking the card itself is the second.
    if (this.#pinned.get(uuid)?.isConnected) return this.#unpin(uuid);

    const card = await descriptionCard(uuid);
    if (!card) return;
    // Anchored to the slot, opening upwards: the bar sits at the bottom edge, and
    // core clamps the card into the viewport from there.
    tips.deactivate();
    tips.activate(slot, { html: card.html, direction: "UP" });
    // The classes go on the tooltip element itself rather than on a wrapper inside
    // it, because that is where dnd5e's own card CSS expects them - a wrapper gets
    // the colours and none of the layout. `hudtra-tooltip` comes OFF for the same
    // reason: the slot sits under a data-tooltip-class, and inheriting it would
    // repaint dnd5e's card in the bar's leather - and would put the card in the set
    // the next middle click dismisses.
    this.#dressCard(tips.tooltip, card);
    const locked = tips.lockTooltip?.();
    // No pinning API (a core version that dropped it): the card still showed, it just
    // fades with the pointer. Degraded, not broken, and nothing to clean up - but it
    // is still the live element that needs placing.
    if (!locked) return this.#placeCard(tips.tooltip, slot);
    this.#dressCard(locked, card);
    // AFTER dressing, and after locking: the clone copies the live tooltip's inline
    // styles, so placing it before this would be overwritten by core's own numbers.
    this.#placeCard(locked, slot);
    this.#pinned.set(uuid, locked);
    // Click to dismiss, the way core's own pinned tooltips behave. Bound on the
    // element we just created (and gone with it), and skipped on links so a @UUID
    // reference inside the card stays clickable.
    locked.addEventListener("click", event => {
      if (event.target?.closest?.("a")) return;
      this.#unpin(uuid);
    });
  }

  /**
   * PUT A PINNED CARD WHERE IT ACTUALLY FITS.
   *
   * Core anchors a tooltip to the element it was opened on, measures it, and clamps
   * the result into the viewport. That is right for a two-line hover card and wrong
   * for a full item description, for one reason that is entirely ours: the card is
   * measured BEFORE `hudtra-desc-pin` is on it, so core sizes a completely unbounded
   * box - a long feature is easily taller than the screen - and positions from that
   * height. Its clamp cannot save it either, because clamping a box taller than the
   * viewport has no answer. The height cap then lands a moment later and shrinks the
   * card, but the top it was given is already far off the screen, which is exactly
   * what a long description looked like: pinned somewhere above the ceiling.
   *
   * So: cap first, measure second, place third. The cap comes from the space that is
   * really above the slot rather than a fixed fraction of the viewport, because the
   * bar's own height is a setting (--hudtra-scale, and the grid's row count) and a
   * tall bar eats the space a fixed 60vh assumes is there. Past the cap the card
   * scrolls inside itself - see .hudtra-desc-pin.
   *
   * ANCHORED TO THE SLOT, NOT CENTRED ON THE SCREEN, deliberately: several cards can
   * be pinned at once, and centring would stack them all on the same spot. Above the
   * slot, because the bar owns the bottom edge; centred over it horizontally and
   * clamped, so a card opened on the last button does not run off the right.
   */
  #placeCard(el, slot) {
    if (!el || !slot) return;
    const { margin, minHeight } = DESC_CARD;
    const anchor = slot.getBoundingClientRect();
    // The bar owns the bottom edge, so the space above the slot is all there is.
    const above = anchor.top - margin * 2;
    const roomy = above >= minHeight;
    const cap = roomy ? above : Math.min(minHeight, window.innerHeight - margin * 2);
    el.style.setProperty("--hudtra-desc-max", `${Math.round(cap)}px`);

    // ANCHORED BY ONE FIXED EDGE, never by a measured height. dnd5e's card carries an
    // <img>, and an uncached one loads after this runs - a card positioned as
    // "slot.top minus my height" would then grow straight back off the screen, which
    // is the bug this method exists for in its second form. With room above, the fixed
    // edge is the bottom and the card grows upwards into the space the cap already
    // reserved. Without room it is the top, and the cap keeps the growth inside the
    // viewport; the card then overlaps the bar, which on a screen that short is the
    // better trade - a readable card covering some buttons can be clicked away, one
    // squeezed into a letterbox is simply useless.
    if (roomy) {
      el.style.top = "auto";
      el.style.bottom = `${Math.round(window.innerHeight - anchor.top + margin)}px`;
    } else {
      el.style.bottom = "auto";
      el.style.top = `${margin}px`;
    }

    // Width is CSS-driven for both card kinds (dnd5e's own, and the plain fallback's
    // max-width), so unlike the height it does not move after being read.
    const width = el.getBoundingClientRect().width;
    el.style.left = `${Math.round(Math.clamp(
      anchor.left + (anchor.width - width) / 2,
      margin,
      Math.max(margin, window.innerWidth - width - margin)
    ))}px`;
  }

  /** dnd5e's classes on, the bar's hover-card class off. Both elements, see above. */
  #dressCard(el, card) {
    if (!el) return;
    el.classList.remove("hudtra-tooltip");
    el.classList.add(...card.classes, "hudtra-desc-pin");
  }

  /** Take one pinned card away. Safe to call for one that is already gone. */
  #unpin(uuid) {
    const el = this.#pinned.get(uuid);
    this.#pinned.delete(uuid);
    if (el?.isConnected) game.tooltip?.dismissLockedTooltip?.(el);
  }

  /**
   * Take them all away. The cards are anchored to slots, so they have to go whenever
   * those slots stop meaning what they meant: a different creature in the bar, or the
   * bar sliding away entirely.
   */
  #unpinAll() {
    for (const uuid of [...this.#pinned.keys()]) this.#unpin(uuid);
  }

  /* -------------------------------------------- */

  async _prepareContext(options) {
    // The combatant is the SUBJECT'S own, never the acting one, so the economy row
    // always belongs to the creature actually in the bar. Outside an encounter - or
    // for someone watching a creature that isn't in the fight - it stays null, which
    // is exactly what keeps every economy call below inert.
    const actor = this.subjectActor;
    // A pinned description belongs to the creature it was opened on. Turn changes and
    // token clicks swap the whole bar underneath it, so drop it rather than leave a
    // goblin's feature floating over a player's abilities.
    if (this.#shownActorUuid !== (actor?.uuid ?? null)) {
      this.#shownActorUuid = actor?.uuid ?? null;
      this.#unpinAll();
      // Same reasoning: a level picked out on one creature's strip means nothing on
      // the next one, and silently hiding half of a wizard's bar because a warlock
      // was selected earlier is the worst kind of stale state.
      this.#category = null;
    }
    const combatant = this.#combatantOf(actor);
    const inCombat = !!combatant;
    const isMyTurn = !!combatant && game.combat?.combatant?.id === combatant.id;
    const isMine = actor?.isOwner === true;
    // Also read by the drag handlers, which run outside a render and have no context.
    this.#editable = isMine || game.user.isGM;

    // Whether anything is COUNTED for this creature. A GM-run monster gets the whole
    // bar - portrait, groups, buttons, the gear - and no economy: see
    // economy.isTracked for why that is an ownership question and not an actor.type
    // one. The list half of this context is deliberately untouched by it.
    const tracked = isTracked(actor);
    // Every economy call below reads through this rather than `combatant`, so an
    // untracked creature makes them inert in exactly the way being outside an
    // encounter already did - no second set of branches. `combatant` itself stays
    // live, because the round counter and End Turn are turn state, not economy.
    const econCombatant = tracked ? combatant : null;
    const showEconomy = inCombat && tracked;
    const econ = getEconomy(econCombatant);

    // Conditions do not shrink the pools, they bar them - so the pips stay and are
    // drawn as spent. A Stunned creature with an empty economy row would read as a
    // broken bar; one with four crossed-out pips reads as Stunned.
    const blocked = blockedPools(econCombatant);
    const coupled = coupledPools(econCombatant);
    // Which pools a coupling has already closed, for every pool at once. Asked per
    // pool this re-matched the effect tables and re-read the economy each time, in
    // both loops below.
    const coupledOutNow = coupledOutPools(econCombatant, econ);
    const conditions = blockingConditions(econCombatant)
      .map(s => game.i18n.localize(CONFIG.DND5E?.conditionTypes?.[s]?.label ?? s));
    const blockedHint = conditions.length
      ? game.i18n.format(`${MODULE_ID}.blockedBy`, { conditions: conditions.join(", ") })
      : "";

    const pools = !showEconomy ? [] : POOL_ORDER
      .filter(key => key !== "other")
      .map(key => {
        const def = RESOURCES[key];
        // poolMax, not econ.max: an Action Surge raises the pool for this turn, and
        // the pips are where that has to become visible.
        const max = poolMax(econ, key);
        const used = econ.used[key] ?? 0;
        const spentByCoupling = coupledOutNow.has(key);
        const out = blocked.has(key) || spentByCoupling;
        // Shown while the coupling is merely PENDING - once it has bitten, the pool
        // is drawn as barred and saying "one of these two" as well would be noise.
        const linked = coupled.has(key) && !out;
        return {
          key,
          icon: def.icon,
          label: game.i18n.localize(`${MODULE_ID}.pool.${key}`),
          max,
          used,
          left: out ? 0 : max - used,
          blocked: out,
          coupled: linked,
          // The GM may correct any pool by hand; nobody else gets the control, so
          // nobody else gets the hint promising it either.
          adjustable: game.user.isGM,
          hint: blocked.has(key) ? blockedHint
            : (out || linked) ? game.i18n.localize(`${MODULE_ID}.coupledPools`) : "",
          hidden: max <= 0,
          pips: Array.fromRange(Math.max(max, used)).map(i => ({ spent: out || i < used }))
        };
      })
      .filter(p => !p.hidden);

    const buckets = collectActions(actor);
    const attacksPerAction = getAttacksPerAction(econCombatant);
    const slotRows = spellSlots(actor);
    const spellBar = spellBarFor(slotRows);
    // The ceiling every leveled spell on the bar is measured against, resolved once
    // per render rather than per slot.
    const castable = highestCastable(slotRows);
    const poolGroups = POOL_ORDER
      .map(key => {
        const def = RESOURCES[key];
        // A queued Extra Attack (econ.attacksLeft) keeps the action group usable
        // even once the action pip itself reads as spent - but the action was
        // already committed to attacking, so only attack activities (and attack
        // substitutes like the Dragonborn's Breath Weapon) stay live.
        const hasFreeAttack = key === "action" && (econ.attacksLeft ?? 0) > 0;
        const midAttackSequence = hasFreeAttack && remainingOf(econ, key) <= 0;
        const label = game.i18n.localize(`${MODULE_ID}.pool.${key}`);
        // Only per-turn pools can exhaust; "other" and "passive" have no budget.
        // A barring condition beats the queued-attack shortcut: being Stunned
        // mid-sequence ends it, it does not let the rest through for free.
        // Nothing exhausts on an untracked creature - and this has to say so
        // explicitly rather than lean on the null combatant, because `legendary`
        // has no world default, so its recomputed max is 0 and the group would
        // grey itself out on every monster that has one.
        // Computed BEFORE the entries, because in the grid there is no group left to
        // grey out: it rides along on each slot instead.
        const exhausted = tracked && (blocked.has(key) || coupledOutNow.has(key)
          || (def.perTurn && !hasFreeAttack && remainingOf(econ, key) <= 0));
        const entries = (buckets[key] ?? [])
          .map(entry => {
            // Resolved in collectActions, so a per-entry override is already folded in.
            const isAttackEntry = key === "action" && entry.countsAsAttack;
            // Show "available/total" on attack activities whenever this actor has
            // more than one attack per action, so it is visible even before the first
            // attack (not just once mid-sequence) - it answers "why can I still use
            // this" for a Fighter with Extra Attack.
            let attacksBadge = null;
            if (isAttackEntry) {
              // An entry may carry its own total, in which case the badge has to
              // promise THAT number rather than the actor's.
              const total = entry.attacks ?? attacksPerAction;
              if (total > 1) {
                const available = remainingOf(econ, "action") > 0 ? total : (econ.attacksLeft ?? 0);
                attacksBadge = {
                  available, max: total,
                  hint: game.i18n.format(`${MODULE_ID}.attacksAvailable`, { available, max: total })
                };
              }
            }
            const enriched = { ...entry, locked: midAttackSequence && !entry.countsAsAttack, attacksBadge };
            enriched.action ??= "use";
            // Carried on the entry rather than read back out of the template's context
            // stack: the slot markup now sits one loop deeper (group -> section -> entry).
            enriched.pool = key;
            enriched.exhausted = exhausted;
            // Out of slots to pay for it. Greyed, never hidden: what you cannot cast
            // this round you can still read, and it comes back on its own after a
            // rest. Cantrips and at-will/innate casting never grey out - they cost no
            // slot - and a creature with no slot pools at all greys nothing, because
            // there is nothing to conclude from an absent resource.
            enriched.unavailable = entry.itemType === "spell" && !entry.atWill
              && castable !== null && Number(entry.level ?? 0) > 0
              && Number(entry.level ?? 0) > castable;
            enriched.tooltipHtml = tooltipFor(enriched, label);
            return enriched;
          });
        // Nothing but a carrier for its entries: the grid is rebuilt from them below
        // and drawn as one headerless field, so a group object of its own would be
        // discarded again the moment it was built.
        return { key, entries };
      })
      .filter(g => g.entries.length);

    // ONE LAYOUT, FOR EVERY CREATURE: BG3's single grid, with the pool drawn as a
    // marker on each slot and the categories as tabs above it.
    //
    // There used to be a second one - auto-grouped pool columns with foldable headers,
    // for creatures only the GM owns - on the reasoning that nobody curates twelve
    // goblins and that the headers are how an unfamiliar statblock is read. The first
    // half was never a reason for a different LAYOUT: an unarranged grid packs itself
    // in pool order and needs no curating. The second was answered by the cost marker
    // and the tabs, which say the same thing in less space. What it actually produced
    // was one bar that kept getting better and a second that quietly stayed behind.
    const enriched = Object.fromEntries(poolGroups.map(g => [g.key, g.entries]));
    const tabs = tabsFor(enriched, this.#category);
    // Same self-clearing rule the spell filter follows: a tab that is no longer there
    // cannot be un-picked, so the filter drops rather than emptying the grid.
    if (this.#category && !tabs.some(t => t.key === this.#category)) this.#category = null;
    const rows = gridRowCount();
    const gridEntries = gridFor(enriched, this.#category);
    // The unfiltered grid is drawn as CELLS, so the gaps somebody left are gaps and
    // the empty ones can be dropped on. A category tab is a lens, not an arrangement:
    // it packs, because a filtered grid full of holes where the other categories sit
    // would say nothing about anything.
    const cells = this.#category ? gridEntries : gridCells(gridEntries, rows);
    const groups = gridEntries.length
      ? [{ key: "grid", exhausted: false, entries: cells,
           sections: [{ key: "", entries: cells }] }]
      : [];
    const hp = actor?.system?.attributes?.hp ?? null;
    const isDying = !!hp && hp.value <= 0;
    const rollsDeathSave = isDying && actor?.type === "character";
    // Temporary hit points are a BUFFER, not part of the pool: they are spent first,
    // they do not heal, and they do not raise the maximum. So they are neither folded
    // into value/max - which would claim the creature has more hit points than it has -
    // nor drawn as an arc on the ring, which has no room left at full health - the
    // one state a creature is usually in when it picks temp HP up. They colour the
    // ring's rim and are named on the label instead (see .hudtra-portrait-ring
    // .has-temp). Read defensively: `temp` is null on an untouched sheet.
    const tempHp = Math.max(0, Number(hp?.temp) || 0);
    // Successes and failures, but only where they are actually rolled: rollsDeathSave
    // already means "dying AND a character", and an NPC statblock carries no
    // `attributes.death` at all, so both halves of this guard earn their place.
    const death = actor?.system?.attributes?.death;
    const deathSaves = rollsDeathSave && death
      ? { success: deathPips(death.success), failure: deathPips(death.failure) }
      : null;
    // The pips take the pill's slot from the HP numbers while dying, so the reading
    // that is no longer written out goes in the tooltip - including the max, which is
    // the one thing the numbers were still saying.
    const deathTooltip = deathSaves
      ? game.i18n.format(`${MODULE_ID}.deathSaves`, {
        success: Math.clamp(Number(death.success) || 0, 0, DEATH_SAVE_PIPS),
        failure: Math.clamp(Number(death.failure) || 0, 0, DEATH_SAVE_PIPS),
        max: DEATH_SAVE_PIPS,
        hpMax: hp?.max ?? 0
      })
      : "";
    const hpPct = hp?.max > 0 ? Math.round(100 * Math.clamp(hp.value, 0, hp.max) / hp.max) : 0;

    // A level-up can change what the detection would suggest without changing
    // anything visible in the bar (Extra Attack adds no new entry), so a new
    // suggestion marks the gear instead of silently overwriting what was configured.
    // Cleared from inside the dialog, per suggested value (see config.attackNotice).
    // Only where it is counted: the dialog hides the attacks-per-action field on an
    // untracked creature, and a mark pointing at a field that is not there is worse
    // than no mark.
    const notice = tracked && actor ? attackNotice(actor) : null;
    return {
      hasSubject: !!actor,
      inCombat,
      showEconomy,
      isMyTurn,
      isMine,
      isGM: game.user.isGM,
      actor,
      combatant,
      name: combatant?.name ?? actor?.name ?? "",
      img: combatant?.img ?? actor?.img,
      hp,
      // Presentation-only fields: the CSS scales the whole bar off --hudtra-scale
      // and draws the portrait's HP ring from --hudtra-hp-pct.
      hpPct,
      tempHp,
      tempTooltip: game.i18n.format(`${MODULE_ID}.tempHp`, { value: tempHp }),
      deathSaves,
      deathTooltip,
      scale: game.settings.get(MODULE_ID, "scale") ?? HUD_SCALE.default,
      isDying,
      portraitTooltip: game.i18n.localize(`${MODULE_ID}.${rollsDeathSave ? "deathSave" : "openSheet"}`),
      ac: actor?.system?.attributes?.ac?.value ?? null,
      round: game.combat?.round ?? 0,
      pools,
      spellBar,
      // The column beside the portrait exists for either half: a wizard out of combat
      // has no pips and still wants to see slots.
      resources: showEconomy || !!spellBar,
      tabs,
      // The grid's height in rows. Clamped on read as well as on write: the setting is
      // a number a user could have edited to anything.
      gridRows: rows,
      canAddRow: rows < GRID_ROWS.max,
      canRemoveRow: rows > GRID_ROWS.min,
      addRowTooltip: game.i18n.localize(`${MODULE_ID}.grid.addRow`),
      removeRowTooltip: game.i18n.localize(`${MODULE_ID}.grid.removeRow`),
      groups,
      configNotice: !!notice,
      configTooltip: notice
        ? game.i18n.format(`${MODULE_ID}.config.notice.gear`, notice)
        : game.i18n.localize(`${MODULE_ID}.config.open`),
      editable: this.#editable
    };
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onUse(event, target) {
    const entry = target.dataset;
    const doc = await fromUuid(entry.uuid);
    if (!doc) return;
    // entry.kind is "item" for items with several activities in the same economy
    // bucket (see actions.collectActions) - Item5e#use() shows the same activity
    // picker the character sheet's own roll button does. Otherwise it's a single
    // unambiguous activity, used directly.
    // NOTE: we do NOT spend here. scripts/module.mjs listens to dnd5e.postUseActivity,
    // so macros, chat cards and Midi rolls all book through the same code path.
    return doc.use({ event });
  }

  /**
   * Middle click on a slot, or left click on a passive feature: pin dnd5e's own
   * description card beside it (see #pinDescription).
   */
  static async #onShowDescription(event, target) {
    return this.#pinDescription(target);
  }

  /**
   * Slide the bar away and back. Deliberately NOT a re-render: toggling the class on
   * the persistent root is what makes the transition animate. Pinned description
   * cards go with it - they are anchored to slots that are on their way off screen.
   */
  static #onCollapse() {
    this.#collapsed = !this.#collapsed;
    if (this.#collapsed) this.#unpinAll();
    this.element.classList.toggle("collapsed", this.#collapsed);
  }

  /**
   * Narrow the grid to one category, or - clicking the lit tab - back to everything.
   * The same two-state control the spell levels are, for the same reason: the tab that
   * narrowed the grid is the tab that widens it, so there is nothing extra to find.
   */
  static async #onToggleCategory(event, target) {
    const key = target.dataset.category;
    if (!key) return;
    // "All" only ever clears: it is the filter's off switch, not a filter of its own.
    const next = key === ALL_TAB || this.#category === key ? null : key;
    // Clicking the lit "All" is the one click that changes nothing - and a full
    // rebuild of the bar to draw the identical thing is worth not doing.
    if (next === this.#category) return;
    this.#category = next;
    return this.render();
  }

  /**
   * Add or drop a row of slots, BG3's `+` / `-` next to End Turn. A client setting, so
   * it survives a reload and stays that person's answer - the template only renders
   * the button that has somewhere to go, and this clamps again anyway.
   */
  static async #onRows(event, target) {
    const delta = Number(target.dataset.delta);
    if (!Number.isFinite(delta)) return;
    const now = Number(game.settings.get(MODULE_ID, "gridRows")) || GRID_ROWS.default;
    const next = Math.clamp(now + delta, GRID_ROWS.min, GRID_ROWS.max);
    if (next === now) return;
    await game.settings.set(MODULE_ID, "gridRows", next);
    return this.render();
  }

  /**
   * Portrait click: at 0 HP a Player Character rolls a death save (the skull
   * overlay advertises this); everyone else just gets their sheet. Opening the
   * sheet stays permission-gated by Foundry itself.
   */
  static async #onPortrait() {
    const actor = this.subjectActor;
    if (!actor) return;
    const hp = actor.system?.attributes?.hp;
    if (actor.type === "character" && (hp?.value ?? 1) <= 0 && actor.rollDeathSave) {
      return actor.rollDeathSave({});
    }
    return actor.sheet?.render(true);
  }

  /**
   * Opens the per-actor config on whoever the bar is currently showing. The dialog
   * itself lists every actor this user may configure, so a GM who opened it on a
   * goblin can switch to a player character without waiting for their turn.
   */
  static async #onConfig() {
    return openConfig(this.subjectActor);
  }

  /**
   * GM control on the economy row: left click hands one pip back, right click takes
   * one. Every pool that is shown, not just the action and the bonus - the same
   * correction applies to a reaction spent on a ruling that got reversed.
   *
   * This is NOT a second booking site (load-bearing decision 2). That rule is about
   * activity USAGE being counted exactly once, by dnd5e.postUseActivity; this is a
   * manual correction that only ever happens because a person asked for it, and it
   * goes through the same spend/refund in economy.mjs as everything else. The bar
   * already had `reset` on the same footing.
   *
   * `contextmenu` reaches this only because the action is declared as
   * `{ handler, buttons: [0, 2] }` in DEFAULT_OPTIONS. ApplicationV2 does bind the
   * contextmenu listener for every application, but it drops the event unless the
   * action opts into button 2 - which is why right-click silently did nothing here
   * until the declaration changed. A bare function means left-click only.
   */
  static async #onAdjustPool(event, target) {
    event.preventDefault();
    if (!game.user.isGM) return;
    const combatant = this.subjectCombatant;
    const type = target.dataset.pool;
    if (!combatant || !RESOURCES[type]) return;

    if (event.type === "contextmenu") {
      const econ = getEconomy(combatant);
      // Do not let a click push a pool past its own size: the pips would stop
      // matching the number, and there is no pip left to click back.
      if ((econ.used[type] ?? 0) >= poolMax(econ, type)) return;
      await spend(combatant, type, { label: game.i18n.localize(`${MODULE_ID}.manualAdjust`) });
    } else {
      await refund(combatant, type, 1);
    }
    return this.render();
  }

  static async #onReset() {
    return resetTurn(this.subjectCombatant);
  }

  static async #onEndTurn() {
    // Only ever ends the turn of whoever is shown, and only when it is theirs -
    // the button is hidden otherwise, but a stale render must not skip someone
    // else's turn either.
    if (game.combat?.combatant?.id !== this.subjectCombatant?.id) return;
    return game.combat.nextTurn();
  }
}

/* ---------------------------------------------- */

let instance = null;
const refresh = foundry.utils.debounce(() => {
  if (!instance) return;
  // The bar outlives the encounter now (it collapses instead of closing), so the
  // close condition is "nobody to show", not "no combat".
  if (!instance.hasSubject) return instance.close();
  instance.render({ force: true });
}, DEBOUNCE_MS);

export function getHUD() {
  return (instance ??= new CombatHUD());
}

export function refreshHUD() {
  refresh();
}

/**
 * WHOSE CHANGES THE BAR HAS TO REDRAW FOR.
 *
 * The document hooks in module.mjs fire for every creature in the world, and a
 * re-render rebuilds the whole bar: every item on the sheet is enumerated, bucketed
 * and given a hover card. In an encounter of a dozen monsters trading blows - or
 * under any module that ticks effects each turn - that was a full rebuild per update,
 * on every client, nearly all of it producing byte-identical markup, because the bar
 * shows exactly ONE creature.
 *
 * Lives here rather than in module.mjs because it is the same question subjectActor
 * answers, and the two have to agree.
 *
 * The rule is "when in doubt, redraw": a change that cannot be attributed to an actor
 * still refreshes, and so does every hook that does NOT come through here - combat,
 * adding and removing combatants, token selection, the user's assigned character -
 * which is where WHICH creature the bar shows is actually decided.
 */
export function refreshHUDFor(actor, changed = {}) {
  // Ownership decides who the bar falls back to when no token is selected, so it
  // redraws whichever creature it landed on (see CombatHUD#subjectActor).
  if (changed.ownership !== undefined) return refresh();
  if (!actor) return refresh();
  const subject = instance?.subjectActor;
  // Nothing on the bar yet: let the debounced refresh decide, exactly as before.
  if (!subject) return refresh();
  if (actor === subject || actor.uuid === subject.uuid) return refresh();
  // Per-actor config lives on the BASE actor (see config.configTarget), which an
  // unlinked token's synthetic actor shadows - so a rule written there does reach a
  // bar showing one of its tokens.
  if (configTarget(subject)?.uuid === actor.uuid) return refresh();
}
