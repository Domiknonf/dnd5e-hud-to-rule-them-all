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
  /**
   * Typography is taste, and taste is not something a module gets to settle for
   * somebody else's table. Three stacks rather than a free-text font name: a
   * mistyped family is a silent downgrade nobody can see the cause of.
   */
  reg("font", {
    ...CLIENT, type: String, default: "fantasy",
    choices: {
      fantasy: `${MODULE_ID}.settings.font.fantasy`,
      clean:   `${MODULE_ID}.settings.font.clean`,
      system:  `${MODULE_ID}.settings.font.system`
    }
  });
  /**
   * How many rows of slots a pool stacks into. A trade, not a preference with a
   * right answer: every extra row makes the bar one slot taller and roughly a
   * third narrower, and which of the two is scarce depends on the screen and on
   * whether the table plays casters or a pack of goblins.
   */
  reg("slotRows",           { ...CLIENT, type: Number, default: 3, range: { min: 1, max: 4, step: 1 } });
  reg("groupByCategory",    { ...CLIENT, type: Boolean, default: true });
  reg("sortAlphabetically", { ...CLIENT, type: Boolean, default: false });
  reg("scale",              { ...CLIENT, type: Number, default: 1, range: { min: 0.6, max: 1.6, step: 0.05 } });

  /**
   * Which category rails the user has folded away, as "pool/section" keys. Hidden
   * from the settings sheet on purpose: it is written by clicking a rail, and a
   * list of opaque keys is not something anyone should edit by hand.
   *
   * An ARRAY, not a map of booleans. game.settings.set stores whatever it is given
   * and un-collapsing has to REMOVE a key - with an object that means relying on
   * replace-not-merge semantics, while an array simply cannot leave a stale `true`
   * behind. Registered directly because the hidden setting has no name or hint to
   * localize, and deliberately without `onChange: refreshHUD`: the handler toggles
   * the class itself, and a whole-bar re-render to hide six icons is waste.
   */
  game.settings.register(MODULE_ID, "collapsedSections", {
    scope: "client", config: false, type: Array, default: []
  });
}
