import { MODULE_ID, RESOURCES, SECTIONS, SECTION_MIN_ENTRIES, DEBOUNCE_MS } from "./const.mjs";
import {
  getEconomy, resetTurn, remaining, getAttacksPerAction, combatantFor, spend, refund, poolMax,
  blockedPools, blockingConditions, coupledOut, coupledPools, isTracked
} from "./economy.mjs";
import { collectActions } from "./actions.mjs";
import { spellSlots } from "./spells.mjs";
import { openConfig, attackNotice } from "./config-app.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * BG3-style hover card, injected via data-tooltip-html (core cleans the HTML with
 * foundry.utils.cleanHTML before display). Pure presentation: big icon, name, a
 * meta line (pool + spell level) and one row per known detail. All dynamic values
 * are escaped - item names are user content.
 */
function tooltipFor(entry, poolLabel) {
  const esc = Handlebars.escapeExpression;
  const img = entry.img ? `<img src="${esc(entry.img)}" alt="">` : "";
  const spellLevel = entry.itemType === "spell" && entry.level != null
    ? game.i18n.localize(CONFIG.DND5E?.spellLevels?.[entry.level] ?? "") : "";
  // The activity's own name leads the meta line on a split button: it is the one
  // word that tells this half of the item from the other one, which otherwise shares
  // its name and its art.
  const meta = [entry.subtitle, poolLabel, spellLevel].filter(Boolean).map(esc).join(" &middot; ");
  const rows = [];
  const row = (key, value) => rows.push(
    `<div class="hudtra-tt-row"><dt>${esc(game.i18n.localize(`${MODULE_ID}.tooltip.${key}`))}</dt><dd>${esc(value)}</dd></div>`
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
    + (entry.description ? `<p class="hudtra-tt-hint">${esc(game.i18n.localize(`${MODULE_ID}.tooltip.middleClick`))}</p>` : "")
    + `</div>`;
}

/* ---------------------------------------------- */
/*  Folding                                        */
/* ---------------------------------------------- */

/**
 * Which groups and sections this user keeps folded away, as `{ id: true }`. Always an
 * object - the setting is written by the bar itself (see #onToggleFold) and read on
 * every render.
 */
function foldedIds() {
  return game.settings.get(MODULE_ID, "folded") ?? {};
}

function foldTooltip(label, count, folded) {
  return game.i18n.format(`${MODULE_ID}.fold.${folded ? "show" : "hide"}`, { label, count });
}

/**
 * Split one group's entries into sections (see SECTIONS in const.mjs), or leave it as
 * the single plain grid it has always been.
 *
 * There is one code path either way: the flat case is one nameless section, so the
 * template has one loop over sections and not two copies of the slot markup. The three
 * ways to stay flat, in order:
 *
 * 1. The user turned sectioning off.
 * 2. The group is small enough that dividers and chips cost more than they save.
 * 3. Everything in it is the same kind of thing anyway - a passive list is all feats,
 *    and one section spanning the whole group says nothing while still charging for
 *    the chrome.
 *
 * Sections group BEFORE the per-entry `sort` rule, which orders entries within one.
 * That is the trade: a spell dragged to the front of the Action zone leads the spells
 * rather than the whole group. Turning the setting off gives the flat order back.
 *
 * `filtering` says a spell level is currently picked out on the strip. It force-opens
 * the spell section for as long as that lasts: clicking "level 3" and watching nothing
 * happen because spells were folded away is not an answer anybody wants. It is a
 * transient override and never touches the stored fold - clearing the filter puts the
 * section back exactly as it was, which is why this is not done by rewriting the
 * setting.
 */
function sectionsFor(poolKey, entries, folded, filtering = false) {
  const flat = { sectioned: false, sections: [{ key: "", collapsed: false, entries }] };
  if (!game.settings.get(MODULE_ID, "groupSections")) return flat;
  if (entries.length < SECTION_MIN_ENTRIES) return flat;

  const byKey = new Map();
  for (const entry of entries) {
    if (!byKey.has(entry.section)) byKey.set(entry.section, []);
    byKey.get(entry.section).push(entry);
  }
  if (byKey.size < 2) return flat;

  const sections = [...byKey]
    .sort((a, b) => (SECTIONS[a[0]]?.order ?? 99) - (SECTIONS[b[0]]?.order ?? 99))
    .map(([key, list]) => {
      const id = `${poolKey}:${key}`;
      const label = game.i18n.localize(`${MODULE_ID}.section.${key}`);
      const collapsed = folded[id] === true && !(filtering && key === "spell");
      // Spells read by level, the way every character sheet lists them: cantrips
      // first, then 1st upwards. Array#sort is stable, so the configured order (and
      // the A-Z setting) still decides within one level.
      const ordered = key === "spell"
        ? [...list].sort((a, b) => (a.level ?? 0) - (b.level ?? 0))
        : list;
      return {
        key, id, label, collapsed,
        entries: ordered,
        count: list.length,
        icon: SECTIONS[key]?.icon ?? "fa-solid fa-circle",
        tooltip: foldTooltip(label, list.length, collapsed)
      };
    });
  return { sectioned: true, sections };
}

/* ---------------------------------------------- */
/*  Spell strip                                    */
/* ---------------------------------------------- */

/**
 * The strip above the bar: one chip per spell level this creature either has slots for
 * or has spells for, plus a Pact Magic readout. Each chip does two jobs at once -
 * it says how many slots are left, and it filters the bar down to that level.
 *
 * Which levels appear is read off the BAR, not off the spell list: a spell hidden in
 * the gear dialog or filtered out by "hide unprepared" is not castable from here, so a
 * chip that filtered to it would filter to nothing. A level with slots but nothing on
 * the bar still shows - the slots are worth seeing - it just is not a button.
 *
 * Pact Magic is deliberately a readout and not a filter. A pact slot casts anything
 * you know at its level, so there is no set of spells "the pact chip" would mean.
 */
function spellBarFor(actor, buckets, active) {
  const counts = new Map();
  for (const bucket of Object.values(buckets)) {
    for (const entry of bucket) {
      if (entry.itemType !== "spell") continue;
      const level = Number(entry.level ?? 0);
      counts.set(level, (counts.get(level) ?? 0) + 1);
    }
  }

  const rows = spellSlots(actor);
  const leveled = new Map(rows.filter(r => !r.pact).map(r => [r.level, r]));
  const pact = rows.find(r => r.pact) ?? null;
  const keys = [...new Set([...counts.keys(), ...leveled.keys()])].sort((a, b) => a - b);
  if (!keys.length && !pact) return null;

  const slotsOf = (row) => row ? `${row.value}/${row.max}` : "";
  const levels = keys.map(level => {
    const row = leveled.get(level) ?? null;
    const spells = counts.get(level) ?? 0;
    // dnd5e's own level names, localized by the system - "Cantrip", "1st Level", …
    const label = game.i18n.localize(CONFIG.DND5E?.spellLevels?.[level] ?? "") || String(level);
    const filterable = spells > 0;
    const isActive = active === level;
    const hint = filterable
      ? game.i18n.localize(`${MODULE_ID}.spells.${isActive ? "filterOff" : "filterOn"}`)
      : game.i18n.localize(`${MODULE_ID}.spells.nothingHere`);
    return {
      level,
      // Cantrips have no number to show, so they get a letter. Everything else is
      // its own numeral - short enough to stay legible at the bar's smallest scale.
      short: level === 0 ? game.i18n.localize(`${MODULE_ID}.spells.cantripShort`) : String(level),
      slots: slotsOf(row),
      empty: !!row && row.value <= 0,
      filterable,
      active: isActive,
      tooltip: row
        ? `${label} · ${game.i18n.format(`${MODULE_ID}.spells.slotsLeft`, row)}\n${hint}`
        : `${label}\n${hint}`
    };
  });

  return {
    levels,
    pact: pact && {
      short: game.i18n.localize(`${MODULE_ID}.spells.pactShort`),
      slots: slotsOf(pact),
      empty: pact.value <= 0,
      tooltip: `${game.i18n.format(`${MODULE_ID}.spells.pactLabel`, pact)} · `
        + game.i18n.format(`${MODULE_ID}.spells.slotsLeft`, pact)
    },
    // Only ever shown while something is filtered, as the way back that does not
    // require remembering which chip is lit.
    active: active !== null
  };
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
      toggleFold: CombatHUD.#onToggleFold,
      toggleLevel: CombatHUD.#onToggleLevel,
      portrait: CombatHUD.#onPortrait,
      config: CombatHUD.#onConfig,
      adjustPool: CombatHUD.#onAdjustPool,
      reset: CombatHUD.#onReset,
      endTurn: CombatHUD.#onEndTurn
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/hud.hbs` }
  };

  /** Which combatant the HUD is showing. Defaults to the active combatant. */
  #combatantId = null;

  /** Item/activity uuid whose description panel is currently expanded, if any. */
  #descriptionUuid = null;

  /**
   * Spell level the strip is currently filtered to, or null for all of them.
   *
   * Deliberately NOT persisted, unlike a fold: a fold says "I never want to look at
   * this", a filter says "right now I am casting a level 3 spell". Coming back to the
   * bar next session with your cantrips still hidden would be a bug, not a memory.
   */
  #spellLevel = null;

  /** Who the bar showed last render, so a change can close a stale description. */
  #shownActorUuid = null;

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
    if (!game.combat?.started) return null;
    return combatantFor(this.subjectActor);
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
    if (state) this.#descriptionUuid = null;
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
      // the time auxclick arrives). A pinned copy of the hover card on top of the
      // description dialog is just noise: dismiss any freshly pinned hover card
      // before opening the dialog.
      for (const el of document.querySelectorAll(".locked-tooltip.hudtra-tooltip")) {
        game.tooltip?.dismissLockedTooltip?.(el);
      }
      CombatHUD.#onShowDescription.call(this, event, target);
    });
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    this.element.classList.toggle("collapsed", this.#collapsed);
  }

  /**
   * Builds the content for the description panel above the bar. Preferred content
   * is dnd5e's own rich item card (ItemDataModel#richTooltip - the same card the
   * inventory shows on hover, complete with property pills), falling back to a
   * plain enriched description if that API is unavailable.
   */
  async #prepareDescription() {
    if (!this.#descriptionUuid) return null;
    const doc = await fromUuid(this.#descriptionUuid).catch(() => null);
    const item = doc?.item ?? doc;   // an Activity uuid resolves to its parent item
    if (!item) { this.#descriptionUuid = null; return null; }

    if (typeof item.system?.richTooltip === "function") {
      try {
        const card = await item.system.richTooltip();
        const classes = card.classes?.length ? card.classes : ["dnd5e2", "dnd5e-tooltip", "item-tooltip"];
        return { name: item.name, content: `<div class="${classes.join(" ")}">${card.content}</div>` };
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
    const content = `<div class="hudtra-desc-body"><img src="${esc(item.img)}" alt="">`
      + `<div class="hudtra-desc-text">${enriched}</div></div>`;
    return { name: item.name, content };
  }

  /* -------------------------------------------- */

  async _prepareContext(options) {
    // The combatant is the SUBJECT'S own, never the acting one, so the economy row
    // always belongs to the creature actually in the bar. Outside an encounter - or
    // for someone watching a creature that isn't in the fight - it stays null, which
    // is exactly what keeps every economy call below inert.
    const actor = this.subjectActor;
    // An open description belongs to the creature it was opened on. Turn changes and
    // token clicks swap the whole bar underneath it, so drop it rather than leave a
    // goblin's feature pinned above a player's abilities.
    if (this.#shownActorUuid !== (actor?.uuid ?? null)) {
      this.#shownActorUuid = actor?.uuid ?? null;
      this.#descriptionUuid = null;
      // Same reasoning: a level picked out on one creature's strip means nothing on
      // the next one, and silently hiding half of a wizard's bar because a warlock
      // was selected earlier is the worst kind of stale state.
      this.#spellLevel = null;
    }
    const combatant = this.subjectCombatant;
    const inCombat = !!combatant;
    const isMyTurn = !!combatant && game.combat?.combatant?.id === combatant.id;
    const isMine = actor?.isOwner === true;

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
    const conditions = blockingConditions(econCombatant)
      .map(s => game.i18n.localize(CONFIG.DND5E?.conditionTypes?.[s]?.label ?? s));
    const blockedHint = conditions.length
      ? game.i18n.format(`${MODULE_ID}.blockedBy`, { conditions: conditions.join(", ") })
      : "";

    const pools = !showEconomy ? [] : Object.entries(RESOURCES)
      .filter(([key]) => key !== "other")
      .sort((a, b) => a[1].order - b[1].order)
      .map(([key, def]) => {
        // poolMax, not econ.max: an Action Surge raises the pool for this turn, and
        // the pips are where that has to become visible.
        const max = poolMax(econ, key);
        const used = econ.used[key] ?? 0;
        const spentByCoupling = coupledOut(econCombatant, key);
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
    const folded = foldedIds();
    // Built from the UNFILTERED buckets, so the chips keep listing every level while
    // one of them is picked out - otherwise choosing a level would take away the only
    // control that undoes it.
    const spellBar = spellBarFor(actor, buckets, this.#spellLevel);
    const spellLevel = spellBar ? this.#spellLevel : null;
    const groups = Object.entries(RESOURCES)
      .sort((a, b) => a[1].order - b[1].order)
      .map(([key, def]) => {
        // A queued Extra Attack (econ.attacksLeft) keeps the action group usable
        // even once the action pip itself reads as spent - but the action was
        // already committed to attacking, so only attack activities (and attack
        // substitutes like the Dragonborn's Breath Weapon) stay live.
        const hasFreeAttack = key === "action" && (econ.attacksLeft ?? 0) > 0;
        const midAttackSequence = hasFreeAttack && remaining(econCombatant, key) <= 0;
        const label = game.i18n.localize(`${MODULE_ID}.pool.${key}`);
        // The level filter narrows the SPELLS and nothing else: a filter that also
        // took your weapons off the bar would be useless in the one moment it is
        // used, which is mid-turn while deciding what to cast.
        const entries = (buckets[key] ?? [])
          .filter(e => spellLevel === null || e.itemType !== "spell" || Number(e.level ?? 0) === spellLevel)
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
                const available = remaining(econCombatant, "action") > 0 ? total : (econ.attacksLeft ?? 0);
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
            enriched.tooltipHtml = tooltipFor(enriched, label);
            return enriched;
          });
        const collapsed = folded[key] === true;
        const { sectioned, sections } = sectionsFor(key, entries, folded, spellLevel !== null);
        return {
          key,
          icon: def.icon,
          label,
          entries,
          collapsed,
          count: entries.length,
          foldTooltip: foldTooltip(label, entries.length, collapsed),
          sections,
          // The same section objects, named for the other job they do: the chips in
          // the header. Null while the whole group is folded, where per-section
          // controls would toggle something nobody can see.
          chips: sectioned && !collapsed ? sections : null,
          // Only per-turn pools can exhaust; "other" and "passive" have no budget.
          // A barring condition beats the queued-attack shortcut: being Stunned
          // mid-sequence ends it, it does not let the rest through for free.
          // Nothing exhausts on an untracked creature - and this has to say so
          // explicitly rather than lean on the null combatant, because `legendary`
          // has no world default, so its recomputed max is 0 and the group would
          // grey itself out on every monster that has one.
          exhausted: tracked && (blocked.has(key) || coupledOut(econCombatant, key)
            || (def.perTurn && !hasFreeAttack && remaining(econCombatant, key) <= 0))
        };
      })
      .filter(g => g.entries.length);

    const hp = actor?.system?.attributes?.hp ?? null;
    const isDying = !!hp && hp.value <= 0;
    const rollsDeathSave = isDying && actor?.type === "character";
    const description = await this.#prepareDescription();

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
      hpPct: hp?.max > 0 ? Math.round(100 * Math.clamp(hp.value, 0, hp.max) / hp.max) : 0,
      scale: game.settings.get(MODULE_ID, "scale") ?? 1,
      isDying,
      portraitTooltip: game.i18n.localize(`${MODULE_ID}.${rollsDeathSave ? "deathSave" : "openSheet"}`),
      ac: actor?.system?.attributes?.ac?.value ?? null,
      round: game.combat?.round ?? 0,
      pools,
      spellBar,
      spellAllTooltip: game.i18n.localize(`${MODULE_ID}.spells.showAll`),
      groups,
      description,
      // The handle's first stage depends on what is currently open.
      collapseTooltip: game.i18n.localize(`${MODULE_ID}.${description ? "closeDescription" : "toggleBar"}`),
      configNotice: !!notice,
      configTooltip: notice
        ? game.i18n.format(`${MODULE_ID}.config.notice.gear`, notice)
        : game.i18n.localize(`${MODULE_ID}.config.open`),
      editable: isMine || game.user.isGM
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
   * Middle click on a slot (or left click on a passive feature): expand the
   * description panel above the bar for that item, replace its content if a
   * different item is picked, collapse it again when the same item is clicked
   * twice. The X in the panel corner routes to #onCloseDescription.
   */
  static async #onShowDescription(event, target) {
    const uuid = target.dataset.uuid;
    if (!uuid) return;
    this.#descriptionUuid = this.#descriptionUuid === uuid ? null : uuid;
    return this.render();
  }

  /**
   * The single collapse handle works in stages: an open description panel closes
   * first, and only a second click slides the bar itself away. Closing the
   * description needs a re-render (the panel is template-driven), while the bar's
   * slide only toggles a class on the persistent root so the transition animates.
   */
  static #onCollapse() {
    if (this.#descriptionUuid) {
      this.#descriptionUuid = null;
      return this.render();
    }
    this.#collapsed = !this.#collapsed;
    this.element.classList.toggle("collapsed", this.#collapsed);
  }

  /**
   * Fold one group ("passive") or one section of one ("action:spell") away, and
   * remember it for this user. The header that folded it stays, with a count on it,
   * so the way back is the thing you just clicked.
   *
   * Deliberately NOT the bar's own collapse (#onCollapse), which toggles a class
   * without a re-render so the slide animates: a fold re-renders, because folded
   * content has to be out of the DOM rather than merely invisible - a slot hidden with
   * CSS is still a slot the browser lays out, on a bar whose Action group runs to
   * twenty-odd of them.
   */
  static async #onToggleFold(event, target) {
    const id = target.dataset.fold;
    if (!id) return;
    const folded = { ...foldedIds() };
    if (folded[id]) delete folded[id];
    else folded[id] = true;
    // No onChange on this setting: a click re-renders right here rather than through
    // the debounce, so the fold answers immediately.
    await game.settings.set(MODULE_ID, "folded", folded);
    return this.render();
  }

  /**
   * Pick a spell level out on the strip, or - clicking the lit chip, or the "all"
   * chip beside it - put every level back. Session state only, on the instance: see
   * #spellLevel for why this one is not remembered.
   *
   * A blank `data-level` is the "all" chip, which is why this reads the attribute
   * rather than trusting a number to be there.
   */
  static async #onToggleLevel(event, target) {
    const raw = target.dataset.level;
    const level = raw === "" || raw === undefined ? null : Number(raw);
    this.#spellLevel = (level === null || this.#spellLevel === level) ? null : level;
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
   * `contextmenu` reaches this because ApplicationV2 binds it alongside `click` -
   * the same reason the middle-click popup needs its own listener and this does not.
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
