import { MODULE_ID, RESOURCES, DEBOUNCE_MS } from "./const.mjs";
import { getEconomy, spend, refund, dash, resetTurn, remaining, checkGate, getAttacksPerAction } from "./economy.mjs";
import { getMovement } from "./movement.mjs";
import { collectActions } from "./actions.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class CombatHUD extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "hud-to-rule-them-all",
    classes: ["hudtra"],
    tag: "section",
    window: { frame: false, positioned: false },
    actions: {
      use: CombatHUD.#onUse,
      spendPip: CombatHUD.#onSpendPip,
      refundPip: CombatHUD.#onRefundPip,
      dash: CombatHUD.#onDash,
      reset: CombatHUD.#onReset,
      cycleMode: CombatHUD.#onCycleMode,
      endTurn: CombatHUD.#onEndTurn
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/hud.hbs` }
  };

  /** Which combatant the HUD is showing. Defaults to the active combatant. */
  #combatantId = null;

  get combatant() {
    const combat = game.combat;
    if (!combat) return null;
    return combat.combatants.get(this.#combatantId) ?? combat.combatant ?? null;
  }

  setCombatant(id) {
    this.#combatantId = id;
    return this.render();
  }

  /* -------------------------------------------- */

  async _prepareContext(options) {
    const combatant = this.combatant;
    const actor = combatant?.actor ?? null;
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

    const buckets = collectActions(actor, combatant);
    const attacksPerAction = getAttacksPerAction(combatant);
    const groups = Object.entries(RESOURCES)
      .sort((a, b) => a[1].order - b[1].order)
      .map(([key, def]) => {
        // A queued Extra Attack (econ.attacksLeft) keeps the action group usable
        // even once the action pip itself reads as spent - but the action was
        // already committed to attacking, so only attack activities stay live.
        const hasFreeAttack = key === "action" && (econ.attacksLeft ?? 0) > 0;
        const midAttackSequence = hasFreeAttack && remaining(combatant, key) <= 0;
        const entries = (buckets[key] ?? []).map(entry => {
          const isAttackEntry = key === "action" && entry.activityType === "attack";
          // Show "available/total" on attack activities whenever this actor has
          // more than one attack per action configured, so it's visible even before
          // the first attack (not just once mid-sequence) - answers "why can I
          // still use this" without needing the removed Multiattack description.
          let attacksBadge = null;
          if (isAttackEntry && attacksPerAction > 1) {
            const available = remaining(combatant, "action") > 0 ? attacksPerAction : (econ.attacksLeft ?? 0);
            attacksBadge = {
              available, max: attacksPerAction,
              hint: game.i18n.format(`${MODULE_ID}.attacksAvailable`, { available, max: attacksPerAction })
            };
          }
          return { ...entry, locked: midAttackSequence && entry.activityType !== "attack", attacksBadge };
        });
        return {
          key,
          icon: def.icon,
          label: game.i18n.localize(`${MODULE_ID}.pool.${key}`),
          exhausted: key !== "other" && !hasFreeAttack && remaining(combatant, key) <= 0,
          entries
        };
      })
      .filter(g => g.entries.length);

    return {
      hasCombat: !!combatant,
      isMine,
      isGM: game.user.isGM,
      actor,
      combatant,
      name: combatant?.name ?? "",
      img: combatant?.img ?? actor?.img,
      hp: actor?.system?.attributes?.hp ?? null,
      ac: actor?.system?.attributes?.ac?.value ?? null,
      round: game.combat?.round ?? 0,
      pools,
      groups,
      movement: getMovement(combatant),
      editable: isMine || game.user.isGM
    };
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static async #onUse(event, target) {
    const entry = target.dataset;
    if (entry.kind === "intrinsic") return this.constructor.#useIntrinsic.call(this, entry);
    const activity = await fromUuid(entry.uuid);
    if (!activity) return;
    // NOTE: we do NOT spend here. scripts/module.mjs listens to dnd5e.postUseActivity,
    // so macros, chat cards and Midi rolls all book through the same code path.
    return activity.use({ event });
  }

  static async #useIntrinsic(entry) {
    const combatant = this.combatant;
    const type = Object.entries(RESOURCES).find(([k]) => k === entry.type)?.[0] ?? "action";
    // Dash has its own dashCostsAction-driven check inside dash() - unlike the other
    // intrinsic buttons, it was never gated by enforceActions in the first place, so
    // leave it as-is rather than double-gating it here.
    if (entry.handler === "dash") return dash(combatant);

    const result = checkGate(combatant, type);
    if (result !== "allow") {
      const msg = game.i18n.format(`${MODULE_ID}.notify.exhausted`, {
        pool: game.i18n.localize(`${MODULE_ID}.pool.${type}`)
      });
      if (result === "block") { ui.notifications.warn(msg); return; }
      ui.notifications.info(msg);
    }

    if (entry.handler === "skill" && entry.skill) {
      await combatant?.actor?.rollSkill?.({ skill: entry.skill });
    }
    return spend(combatant, type, { label: entry.name });
  }

  static async #onSpendPip(event, target) {
    const pool = target.dataset.pool;
    // Manual "-" has no real event behind it (unlike an over-budget activity use,
    // which still books via postUseActivity so the log stays accurate) - so there is
    // no reason to let it push used past max. Once empty it's a no-op.
    if (remaining(this.combatant, pool) <= 0) return;
    return spend(this.combatant, pool, { label: game.i18n.localize(`${MODULE_ID}.manual`) });
  }

  static async #onRefundPip(event, target) {
    return refund(this.combatant, target.dataset.pool);
  }

  static async #onDash() {
    return dash(this.combatant);
  }

  static async #onReset() {
    return resetTurn(this.combatant);
  }

  static async #onCycleMode(event, target) {
    const combatant = this.combatant;
    const { modes, mode } = getMovement(combatant);
    if (modes.length < 2) return;
    const idx = modes.findIndex(m => m.key === mode);
    const next = modes[(idx + 1) % modes.length];
    await combatant.setFlag(MODULE_ID, "movementMode", next.key);
    return this.render();
  }

  static async #onEndTurn() {
    if (game.combat?.combatant?.id !== this.combatant?.id) return;
    return game.combat.nextTurn();
  }
}

/* ---------------------------------------------- */

let instance = null;
const refresh = foundry.utils.debounce(() => {
  if (!instance) return;
  if (!game.combat?.started) return instance.close();
  instance.render({ force: true });
}, DEBOUNCE_MS);

export function getHUD() {
  return (instance ??= new CombatHUD());
}

export function refreshHUD() {
  refresh();
}
