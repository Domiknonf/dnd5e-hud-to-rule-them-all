import { MODULE_ID } from "./const.mjs";
import { setEntryTarget, configTarget } from "./config.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * The per-ability targeting override: what to do when the item's own Target and
 * Range fields are wrong or missing. A Healing Word imported without its target
 * count, a homebrew buff with no target at all - the detection in targeting.mjs can
 * only read what is there, so this is where a person says what it should be.
 *
 * Stored on the entry's rule as `target` (see config.setEntryTarget), every field
 * optional, an absent field meaning "as detected":
 *   mode       "pick" | "self" | "none"
 *   count      a number of targets, or "any"
 *   range      a distance, or "any"; rangeUnits is the unit it was entered in
 *   filter     "creature" | "ally" | "enemy" | "any"
 *
 * Imports only const.mjs and config.mjs on purpose: targeting.mjs opens this dialog
 * from the picker and config-app.mjs from the gear, and neither may become a cycle.
 */

export const TARGET_MODES = ["pick", "self", "none"];
export const TARGET_FILTERS = ["creature", "ally", "enemy", "any"];
const COUNT_MAX = 50;

/** The length unit the world uses (dnd5e's metric setting), for entering a range. */
export function lengthUnits() {
  try {
    return globalThis.dnd5e?.utils?.defaultUnits?.("length") ?? "ft";
  } catch {
    return "ft";
  }
}

/** A stored rule made safe to use: unknown values dropped rather than trusted. */
export function cleanTargetRule(raw) {
  const rule = {};
  if (!raw || typeof raw !== "object") return rule;
  if (TARGET_MODES.includes(raw.mode)) rule.mode = raw.mode;
  if (raw.count === "any") rule.count = "any";
  else if (Number(raw.count) >= 1) rule.count = Math.min(COUNT_MAX, Math.floor(Number(raw.count)));
  if (raw.range === "any") rule.range = "any";
  else if (Number(raw.range) > 0) {
    rule.range = Number(raw.range);
    rule.rangeUnits = typeof raw.rangeUnits === "string" && raw.rangeUnits ? raw.rangeUnits : "ft";
  }
  if (TARGET_FILTERS.includes(raw.filter)) rule.filter = raw.filter;
  return rule;
}

/**
 * Open the editor. `detected` describes what the activity does without an override
 * ({ text, count, range, filter } - shown as the "Automatic" choice and as input
 * placeholders), `current` is the override in force. Resolves to true when something
 * was saved or reset, false when the dialog was cancelled or may not be saved.
 */
export async function editTargetRule({ actor, keys, name, current = {}, detected = {} }) {
  if (!configTarget(actor)?.isOwner || !keys?.length) {
    ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.targetRule.noPermission`));
    return false;
  }
  const esc = Handlebars.escapeExpression;
  const L = (key, data) => esc(data ? game.i18n.format(`${MODULE_ID}.targetRule.${key}`, data)
    : game.i18n.localize(`${MODULE_ID}.targetRule.${key}`));
  const rule = cleanTargetRule(current);
  const units = rule.rangeUnits ?? lengthUnits();
  const option = (value, label, selected) =>
    `<option value="${value}"${selected ? " selected" : ""}>${label}</option>`;
  const auto = L("auto", { detected: detected.text ?? "" });

  const content = `<div class="hudtra-target-rule">
      <p class="hint">${L("intro")}</p>
      <div class="form-group">
        <label>${L("mode")}</label>
        <div class="form-fields"><select name="mode">
          ${option("", auto, !rule.mode)}
          ${TARGET_MODES.map(m => option(m, L(`modes.${m}`), rule.mode === m)).join("")}
        </select></div>
      </div>
      <div class="form-group">
        <label>${L("count")}</label>
        <div class="form-fields">
          <input type="number" name="count" min="1" max="${COUNT_MAX}" step="1"
                 value="${Number.isFinite(rule.count) ? rule.count : ""}"
                 placeholder="${esc(detected.count ?? "∞")}">
          <label class="checkbox"><input type="checkbox" name="countAny"${rule.count === "any" ? " checked" : ""}> ${L("anyNumber")}</label>
        </div>
      </div>
      <div class="form-group">
        <label>${L("range", { units: esc(units) })}</label>
        <div class="form-fields">
          <input type="number" name="range" min="0" step="any"
                 value="${Number.isFinite(rule.range) ? rule.range : ""}"
                 placeholder="${esc(detected.range ?? "—")}">
          <label class="checkbox"><input type="checkbox" name="rangeAny"${rule.range === "any" ? " checked" : ""}> ${L("noLimit")}</label>
        </div>
      </div>
      <div class="form-group">
        <label>${L("filter")}</label>
        <div class="form-fields"><select name="filter">
          ${option("", L("auto", { detected: L(`filters.${detected.filter ?? "creature"}`) }), !rule.filter)}
          ${TARGET_FILTERS.map(f => option(f, L(`filters.${f}`), rule.filter === f)).join("")}
        </select></div>
      </div>
      <p class="hint">${L("hint")}</p>
    </div>`;

  const read = (form) => {
    const el = form?.elements;
    if (!el) return null;
    return cleanTargetRule({
      mode: el.mode?.value || undefined,
      count: el.countAny?.checked ? "any" : el.count?.value,
      range: el.rangeAny?.checked ? "any" : el.range?.value,
      rangeUnits: units,
      filter: el.filter?.value || undefined
    });
  };

  const result = await DialogV2.wait({
    window: { title: game.i18n.format(`${MODULE_ID}.targetRule.title`, { name }) },
    classes: ["hudtra-target-rule-dialog"],
    position: { width: 440 },
    content,
    buttons: [
      { action: "save", label: L("save"), icon: "fa-solid fa-floppy-disk", default: true,
        callback: (event, button) => read(button?.form) },
      { action: "reset", label: L("reset"), icon: "fa-solid fa-rotate-left", callback: () => ({}) },
      { action: "cancel", label: L("cancel"), icon: "fa-solid fa-xmark", callback: () => null }
    ],
    rejectClose: false
  }).catch(() => null);

  if (!result) return false;
  await setEntryTarget(actor, keys, result);
  ui.notifications.info(game.i18n.format(`${MODULE_ID}.targetRule.${Object.keys(result).length ? "saved" : "cleared"}`, { name }));
  return true;
}
