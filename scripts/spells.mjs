/**
 * SPELL SLOTS, read only. The one place that touches dnd5e's spell resources.
 *
 * VERIFY AT RUNTIME - `actor.system.spells` in the console - if the strip ever comes up
 * empty for an obvious caster. dnd5e keys the leveled slots `spell1` … `spell9`, each
 * `{ value, max }`, and Pact Magic separately as `pact: { value, max, level }`. Every
 * read below is defensive: a key that moved costs one row, never the bar.
 *
 * Imports nothing, on purpose. This is a reader with no opinions - what a level is
 * CALLED and whether it can be filtered to are questions for the HUD, which is the
 * only caller. Keeping them out of here is what keeps this file off the import graph.
 */

/** D&D goes to 9. Not a table to extend - it is the rules. */
const MAX_LEVEL = 9;

/**
 * Every slot pool this creature actually has, in casting order, as
 * `{ level, value, max, pact }`. A level with no slots produces no row at all, which
 * is what keeps a Fighter's strip from listing nine empty ones.
 *
 * Pact Magic is a row of its own rather than folded into its level: it refills on a
 * short rest and is spent separately, so showing "3/4" for a level that also has two
 * pact slots would be a lie in both directions.
 */
export function spellSlots(actor) {
  const spells = actor?.system?.spells;
  if (!spells) return [];

  const rows = [];
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const slot = spells[`spell${level}`];
    const max = Number(slot?.max ?? 0);
    if (!(max > 0)) continue;
    rows.push({ level, value: Math.max(0, Number(slot?.value ?? 0)), max, pact: false });
  }

  const pact = spells.pact;
  const pactMax = Number(pact?.max ?? 0);
  if (pactMax > 0) {
    rows.push({
      level: Number(pact?.level ?? 0),
      value: Math.max(0, Number(pact?.value ?? 0)),
      max: pactMax,
      pact: true
    });
  }
  return rows;
}
