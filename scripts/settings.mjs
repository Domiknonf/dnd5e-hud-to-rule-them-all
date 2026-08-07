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
  reg("scale",              { ...CLIENT, type: Number, default: 1, range: { min: 0.6, max: 1.6, step: 0.05 } });
}
