import { MODULE_ID } from "./const.mjs";
import { refreshHUD } from "./hud.mjs";

const WORLD = { scope: "world", config: true, requiresReload: false };
const CLIENT = { scope: "client", config: true, requiresReload: false };

export function registerSettings() {
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
  reg("maxFree",     { ...WORLD, type: Number, default: 1 });
  reg("dashCostsAction", { ...WORLD, type: Boolean, default: true });

  /* --- Enforcement ------------------------------------------ */
  reg("enforceActions", {
    ...WORLD, type: String, default: "warn",
    choices: {
      off:   `${MODULE_ID}.settings.enforceActions.off`,
      warn:  `${MODULE_ID}.settings.enforceActions.warn`,
      block: `${MODULE_ID}.settings.enforceActions.block`
    }
  });
  reg("enforceMovement", { ...WORLD, type: Boolean, default: false });
  reg("gmBypass",        { ...WORLD, type: Boolean, default: true });

  /* --- Content filters -------------------------------------- */
  reg("hideUnequipped",     { ...WORLD, type: Boolean, default: true });
  reg("hideUnprepared",     { ...WORLD, type: Boolean, default: true });
  reg("showIntrinsic",      { ...WORLD, type: Boolean, default: true });

  /* --- Per-user presentation -------------------------------- */
  reg("sortAlphabetically", { ...CLIENT, type: Boolean, default: false });
  reg("scale",              { ...CLIENT, type: Number, default: 1, range: { min: 0.6, max: 1.6, step: 0.05 } });
  reg("showOnOthersTurn",   { ...CLIENT, type: Boolean, default: true });
}
