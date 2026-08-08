import { MODULE_ID, RESOURCES, DEBOUNCE_MS } from "./const.mjs";
import {
  getEconomy, resetTurn, remaining, getAttacksPerAction, combatantFor,
  multiattackOptions, attacksRemaining
} from "./economy.mjs";
import { collectActions } from "./actions.mjs";
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
  const meta = [poolLabel, spellLevel].filter(Boolean).map(esc).join(" &middot; ");
  const rows = [];
  const row = (key, value) => rows.push(
    `<div class="hudtra-tt-row"><dt>${esc(game.i18n.localize(`${MODULE_ID}.tooltip.${key}`))}</dt><dd>${esc(value)}</dd></div>`
  );
  if (entry.details?.range) row("range", entry.details.range);
  if (entry.details?.target) row("target", entry.details.target);
  if (entry.details?.damage) row("damage", entry.details.damage);
  if (entry.uses) row("uses", `${entry.uses.value}/${entry.uses.max}`);
  if (entry.attacksBadge) rows.push(`<div class="hudtra-tt-row"><dd class="hudtra-tt-attacks">${esc(entry.attacksBadge.hint)}</dd></div>`);
  return `<div class="hudtra-tt">`
    + `<header>${img}<div><span class="hudtra-tt-name">${esc(entry.name)}</span>`
    + (meta ? `<span class="hudtra-tt-meta">${meta}</span>` : "") + `</div></header>`
    + (rows.length ? `<dl class="hudtra-tt-rows">${rows.join("")}</dl>` : "")
    + (entry.description ? `<p class="hudtra-tt-hint">${esc(game.i18n.localize(`${MODULE_ID}.tooltip.middleClick`))}</p>` : "")
    + `</div>`;
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
      portrait: CombatHUD.#onPortrait,
      config: CombatHUD.#onConfig,
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
    }
    const combatant = this.subjectCombatant;
    const inCombat = !!combatant;
    const isMyTurn = !!combatant && game.combat?.combatant?.id === combatant.id;
    const econ = getEconomy(combatant);
    const isMine = actor?.isOwner === true;

    const pools = Object.entries(RESOURCES)
      .filter(([key]) => key !== "other")
      .sort((a, b) => a[1].order - b[1].order)
      .map(([key, def]) => {
        const max = econ.max[key] ?? 0;
        const used = econ.used[key] ?? 0;
        return {
          key,
          icon: def.icon,
          label: game.i18n.localize(`${MODULE_ID}.pool.${key}`),
          max,
          used,
          left: max - used,
          hidden: max <= 0,
          pips: Array.fromRange(Math.max(max, used)).map(i => ({ spent: i < used }))
        };
      })
      .filter(p => !p.hidden);

    const buckets = collectActions(actor);
    const attacksPerAction = getAttacksPerAction(combatant);
    const groups = Object.entries(RESOURCES)
      .sort((a, b) => a[1].order - b[1].order)
      .map(([key, def]) => {
        // A queued Extra Attack (econ.attacksLeft) keeps the action group usable
        // even once the action pip itself reads as spent - but the action was
        // already committed to attacking, so only attack activities (and attack
        // substitutes like the Dragonborn's Breath Weapon) stay live.
        // Mid-action state: either the plain counter has attacks queued, or a
        // configured Multiattack is running and something is still allowed.
        const hasMultiattack = !!multiattackOptions(combatant);
        const hasFreeAttack = key === "action" && (hasMultiattack
          ? !!econ.multiattack
          : (econ.attacksLeft ?? 0) > 0);
        const midAttackSequence = hasFreeAttack && remaining(combatant, key) <= 0;
        const label = game.i18n.localize(`${MODULE_ID}.pool.${key}`);
        const entries = (buckets[key] ?? []).map(entry => {
          // Resolved in collectActions, so a per-entry override is already folded in.
          const isAttackEntry = key === "action" && entry.countsAsAttack;
          // Show "available/total" on attack activities whenever this actor has
          // more than one attack per action configured, so it's visible even before
          // the first attack (not just once mid-sequence) - answers "why can I
          // still use this" without needing the removed Multiattack description.
          // With a configured Multiattack the badge counts down what the surviving
          // options still allow - that is the whole feedback loop, since nothing
          // ever asks which alternative is being taken.
          let attacksBadge = null;
          let spent = false;
          if (isAttackEntry && hasMultiattack) {
            const left = attacksRemaining(combatant, entry.key) ?? 0;
            const max = Math.max(left, econ.multiattack ? left : 0);
            spent = econ.multiattack ? left <= 0 : false;
            if (max > 1 || econ.multiattack) {
              attacksBadge = {
                available: left, max: Math.max(max, left),
                hint: game.i18n.format(`${MODULE_ID}.attacksAvailable`, { available: left, max: Math.max(max, left) })
              };
            }
          } else if (isAttackEntry) {
            // An entry may carry its own total (the alternative Multiattack), in
            // which case the badge has to promise THAT number rather than the actor's.
            const total = entry.attacks ?? attacksPerAction;
            if (total > 1) {
              const available = remaining(combatant, "action") > 0 ? total : (econ.attacksLeft ?? 0);
              attacksBadge = {
                available, max: total,
                hint: game.i18n.format(`${MODULE_ID}.attacksAvailable`, { available, max: total })
              };
            }
          }
          const enriched = { ...entry, locked: (midAttackSequence && !entry.countsAsAttack) || spent, attacksBadge };
          enriched.action ??= "use";
          enriched.tooltipHtml = tooltipFor(enriched, label);
          return enriched;
        });
        return {
          key,
          icon: def.icon,
          label,
          // Only per-turn pools can exhaust; "other" and "passive" have no budget.
          exhausted: def.perTurn && !hasFreeAttack && remaining(combatant, key) <= 0,
          entries
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
    const notice = actor ? attackNotice(actor) : null;
    return {
      hasSubject: !!actor,
      inCombat,
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
