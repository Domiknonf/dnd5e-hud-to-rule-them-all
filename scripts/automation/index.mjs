import { onZeroHp, registerZeroHpTrigger } from "./zero-hp.mjs";
import { fungalInfestation, answerQuery, QUERY } from "./fungal-infestation.mjs";
import { darkOnesBlessing } from "./dark-ones-blessing.mjs";

/**
 * Table automations: rules this table wants handled the moment a creature drops to
 * 0 HP. Each one sits behind its own world setting and is checked when it fires, so
 * switching one off needs no reload.
 *
 * Called from module.mjs's init hook, after registerSettings(). The hooks only act on
 * the active GM's client; the query handler is registered everywhere, because any
 * client may be the one asked.
 *
 * game.user.query is verified live. TODO verify live: CONFIG.queries exists at init
 * (core registers its own handlers there). Check: `Object.keys(CONFIG.queries)`
 * lists the Fungal Infestation QUERY name.
 */
export function registerAutomations() {
  registerZeroHpTrigger();
  onZeroHp("Fungal Infestation", "automationFungalInfestation", fungalInfestation);
  onZeroHp("Dark One's Blessing", "automationDarkOnesBlessing", darkOnesBlessing);
  CONFIG.queries[QUERY] = answerQuery;
}
