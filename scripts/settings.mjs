import { MODULE_ID } from "./const.mjs";
import { refreshHUD } from "./hud.mjs";
import { HudConfig } from "./config-app.mjs";

const WORLD = { scope: "world", config: true, requiresReload: false };
const CLIENT = { scope: "client", config: true, requiresReload: false };

export function registerSettings() {
  /**
   * Second entry point for the per-actor config, next to the HUD's gear. The gear
   * only exists while an encounter runs and only reaches the shown combatant, which
   * is useless for "configure my players' characters before the session" - this one
   * works any time. Not restricted: players configure their own characters here.
   */
  game.settings.registerMenu(MODULE_ID, "actorConfig", {
    name: `${MODULE_ID}.settings.actorConfig.name`,
    label: `${MODULE_ID}.settings.actorConfig.label`,
    hint: `${MODULE_ID}.settings.actorConfig.hint`,
    icon: "fa-solid fa-sliders",
    type: HudConfig,
    restricted: false
  });

  const reg = (key, data) => game.settings.register(MODULE_ID, key, {
    name: `${MODULE_ID}.settings.${key}.name`,
    hint: `${MODULE_ID}.settings.${key}.hint`,
    onChange: refreshHUD,
    ...data
  });

  /* --- Rules ------------------------------------------------ */
  reg("maxAction",   { ...WORLD, type: Number, default: 1 });
  reg("maxBonus",    { ...WORLD, type: Number, default: 1 });
  reg("maxReaction", { ...WORLD, type: Number, default: 1 });

  /* --- Enforcement ------------------------------------------ */
  reg("enforceActions", {
    ...WORLD, type: String, default: "warn",
    choices: {
      off:   `${MODULE_ID}.settings.enforceActions.off`,
      warn:  `${MODULE_ID}.settings.enforceActions.warn`,
      block: `${MODULE_ID}.settings.enforceActions.block`
    }
  });
  reg("gmBypass",        { ...WORLD, type: Boolean, default: true });

  /* --- Content filters -------------------------------------- */
  reg("hideUnequipped",     { ...WORLD, type: Boolean, default: true });
  reg("hideUnprepared",     { ...WORLD, type: Boolean, default: true });

  /* --- Per-user presentation -------------------------------- */
  reg("sortAlphabetically", { ...CLIENT, type: Boolean, default: false });
  reg("groupSections",      { ...CLIENT, type: Boolean, default: true });
  reg("scale",              { ...CLIENT, type: Number, default: 1, range: { min: 0.6, max: 1.6, step: 0.05 } });

  /**
   * Which groups and sections this user has folded away, as `{ id: true }` - a pool
   * key ("passive") for a whole group, "pool:section" for one section of one.
   *
   * NOT in the settings menu (`config: false`): it is written by clicking the bar's
   * own headers, and a raw list of keys is nothing anybody would want to edit by
   * hand. Client-scoped because a fold is a preference about one person's screen, not
   * a fact about the creature - two people looking at the same character fold
   * different things away. This is also why it is not an actor flag: a player would
   * need write access to every monster the GM shows them.
   *
   * Passives start folded: a dozen read-only reference cards are the one part of the
   * bar that is never a turn's business, and the header keeps saying how many are
   * behind it. Unfolding them writes an object without that key, so the default is
   * gone for good rather than coming back on the next reload.
   */
  game.settings.register(MODULE_ID, "folded", {
    scope: "client",
    config: false,
    type: Object,
    default: { passive: true }
  });
}
