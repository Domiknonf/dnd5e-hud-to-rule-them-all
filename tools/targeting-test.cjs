#!/usr/bin/env node
/**
 * End-to-end check of the target picker: a click on the bar and a click on the
 * character sheet, with and without Midi QoL, against the real scripts/targeting.mjs
 * and stubbed Foundry/dnd5e (tools/targeting-test.html). Every case here is one that
 * broke once. Needs Playwright with a Chromium:
 *
 *   node tools/targeting-test.cjs
 *
 * Like verify.mjs it is no substitute for a live world - it proves the module's own
 * logic, not what dnd5e or Midi do with the targets afterwards.
 */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const srv = http.createServer((q, r) => {
  const f = path.join(root, q.url.split('?')[0]);
  if (!f.startsWith(root) || !fs.existsSync(f)) { r.statusCode = 404; return r.end(); }
  r.setHeader('content-type', f.endsWith('.mjs') ? 'text/javascript' : 'text/html');
  r.end(fs.readFileSync(f));
}).listen(0);
let fails = 0;
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log((ok ? "ok    " : "FAIL  ") + name.padEnd(62) + (ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)); };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => ['error', 'warning'].includes(m.type()) && errs.push(m.text()));
  await p.goto(`http://localhost:${srv.address().port}/tools/targeting-test.html`); await p.waitForFunction(() => window.ready);
  const reset = (o = {}) => p.evaluate(o => { log.length = 0; targets = new Set(o.targets ?? []); midi.active = !!o.midi; midi.autoItemEffects = o.midiApply ?? "applyRemove"; settings.targetPicker = o.mode ?? "always"; toks.forEach(t => { t.actor.effects.list = []; t.actor.flags = {}; }); }, o);
  const define = (id, o) => p.evaluate(([id, o]) => { acts[id] = mkAct(id, o); }, [id, o]);
  // click on the bar: starts useFromBar, returns once a picker is up (or it finished)
  const bar = async (id, opts = {}) => { await p.evaluate(([id, shift]) => { window.done = false; T.useFromBar(acts[id], { shiftKey: shift }).then(() => window.done = true); }, [id, !!opts.shift]); await p.waitForFunction(() => window.done || document.getElementById('dlg')); };
  const sheet = async (id, opts = {}) => { await p.evaluate(([id, shift]) => { window.done = false; acts[id].use({ event: { shiftKey: shift } }).then(() => window.done = true); }, [id, !!opts.shift]); await p.waitForTimeout(50); await p.waitForFunction(() => window.done || document.getElementById('dlg')); };
  const checked = () => p.$$eval('#dlg input:checked', i => i.map(x => x.value));
  const confirm = async (pick) => { if (pick) { await p.click(`#dlg li[data-id=${pick}] input`); } await p.click('#dlg button[data-action=confirm]'); await p.waitForFunction(() => window.done); await p.waitForTimeout(50); };
  const L = () => p.evaluate(() => log.filter(e => e[0] !== "picker" && e[0] !== "editor"));
  const pickers = () => p.evaluate(() => log.filter(e => e[0] === "picker").length);

  await define("pfeg", { affects: { type: "willing", count: 1 }, range: { units: "touch" }, effects: true });
  await define("pfegBlank", { affects: {}, range: { units: "touch" }, effects: true });
  await define("bless", { affects: { type: "creature", count: 3 }, range: { units: "ft", value: 30 }, effects: true });
  await define("misty", { affects: { type: "space", count: 1 }, range: { units: "self" } });
  await define("presti", { affects: {}, range: { units: "ft", value: 10 } });
  await define("acid", { type: "damage", affects: {}, range: { units: "ft", value: 90 } });
  await define("bow", { type: "attack", affects: {}, range: { units: "ft", value: 150 } });
  await define("shield", { affects: { type: "self" }, range: { units: "self" }, effects: true });

  for (const midi of [false, true]) {
    const tag = midi ? "[Midi]   " : "[no Midi]";
    // 1. PfEG from the bar
    await reset({ midi, targets: ["gob"] }); await bar("pfeg");
    check(`${tag} bar PfEG: picker opens, self preselected`, await checked(), ["me"]);
    await confirm("ally");
    const want1 = midi ? [["use", "pfeg", "ally"]] : [["use", "pfeg", "ally"], ["socket", "applyEffect", "Actor.ally"]];
    check(`${tag} bar PfEG on ally: one use, targets set, effect`, await L(), want1);
    // 2. PfEG with no target data
    await reset({ midi }); await bar("pfegBlank");
    check(`${tag} bar PfEG without target data: picker, self`, await checked(), ["me"]);
    await confirm();
    check(`${tag} ...cast on self, effect on own actor`, await L(), midi ? [["use", "pfegBlank", "me"]] : [["use", "pfegBlank", "me"], ["effect", "me"]]);
    // 3. Bless after stale targets
    await reset({ midi, targets: ["ally", "gob"] }); await bar("bless");
    check(`${tag} bar Bless: picker opens empty`, await checked(), []);
    await p.click('#dlg li[data-id=me] input'); await confirm("ally");
    check(`${tag} ...Bless on me+ally`, (await L())[0], ["use", "bless", "me,ally"]);
    // 4. Misty Step: targets untouched, no picker
    await reset({ midi, targets: ["gob"] }); await bar("misty");
    check(`${tag} bar Misty Step: no picker, targets untouched`, [await pickers(), await L()], [0, [["use", "misty", "gob"]]]);
    // 5. Prestidigitation (no target, no effect)
    await reset({ midi, targets: ["gob"] }); await bar("presti");
    check(`${tag} bar Prestidigitation: no picker`, [await pickers(), await L()], [0, [["use", "presti", "gob"]]]);
    // 6. Acid Arrow follow-up: current target kept
    await reset({ midi, targets: ["gob"] }); await bar("acid");
    check(`${tag} bar Acid Arrow damage: picker, gob preselected`, await checked(), ["gob"]);
    await confirm();
    // 7. attack
    await reset({ midi, targets: [] }); await bar("bow");
    await confirm("orc");
    check(`${tag} bar Longbow on orc`, await L(), [["use", "bow", "orc"]]);
    // 8. shift-click
    await reset({ midi, targets: ["gob"] }); await bar("pfeg", { shift: true });
    check(`${tag} bar shift-click: no picker, targets kept`, [await pickers(), (await L())[0]], [0, ["use", "pfeg", "gob"]]);
    // 9. cancel
    await reset({ midi, targets: ["gob"] }); await bar("pfeg");
    await p.click('#dlg button[data-action=cancel]'); await p.waitForFunction(() => window.done);
    check(`${tag} bar cancel: nothing used, targets restored`, [await L(), await p.evaluate(() => [...targets])], [[], ["gob"]]);
    // 10. self
    await reset({ midi, targets: ["gob"] }); await bar("shield");
    check(`${tag} bar Shield: self targeted, no picker`, [await pickers(), (await L())[0]], [0, ["use", "shield", "me"]]);
    // 11. setting off
    await reset({ midi, targets: ["gob"], mode: "off" }); await bar("pfeg");
    check(`${tag} setting off: no picker, targets untouched`, [await pickers(), await L()], [0, [["use", "pfeg", "gob"]]]);
    // 12. sheet
    await reset({ midi, targets: ["gob"] }); await sheet("pfeg");
    if (midi) {
      check(`${tag} sheet PfEG: Midi's own handling, untouched`, [await pickers(), await L()], [0, [["use", "pfeg", "gob"]]]);
    } else {
      check(`${tag} sheet PfEG: picker opens`, await checked(), ["me"]);
      await confirm("ally");
      check(`${tag} ...stopped once, restarted aimed`, await L(), [["use-stopped", "pfeg"], ["use", "pfeg", "ally"], ["socket", "applyEffect", "Actor.ally"]]);
    }
  }
  /* ---------------- targeting overrides ---------------- */
  const counter = () => p.textContent('#dlg .hudtra-targets-count');
  const rows = () => p.$$eval('#dlg li', ls => ls.map(l => l.dataset.id + (l.classList.contains('out') ? '(out)' : '')));
  const setRule = (id, rule) => p.evaluate(async ([id, rule]) => {
    const { setEntryTarget } = await import('../scripts/config.mjs');
    await setEntryTarget(acts[id].actor, [`${acts[id].item.id}:${id}`], rule);
  }, [id, rule]);
  const cancel = async () => { await p.click('#dlg button[data-action=cancel]'); await p.waitForFunction(() => window.done); };

  // Healing Word as it comes from an import: a creature target with no count
  await define("hwAny", { type: "heal", affects: { type: "creature" }, range: { units: "ft", value: 60 } });
  // ...and with no target entered at all
  await define("hwBlank", { type: "heal", affects: {}, range: { units: "ft", value: 60 } });

  await reset({}); await bar("hwBlank");
  check(`[override] Healing Word without target data: one target, not any number`, await counter(), 'count{"n":0,"max":1}');
  await cancel();

  await reset({}); await bar("hwAny");
  check(`[override] Healing Word with no count: any number (as the item says)`, await counter(), 'count{"n":0,"max":"∞"}');
  // Adjust from the picker: the editor opens, saving reopens the picker under the rule
  await p.click('#dlg .hudtra-targets-adjust');
  await p.waitForSelector('#rule');
  check(`[override] Adjust: picker closes, editor opens, targets restored`, [await p.$('#dlg') === null, await p.evaluate(() => [...targets])], [true, []]);
  await p.fill('#rule input[name=count]', '1');
  await p.click('#rule button[data-action=save]');
  await p.waitForSelector('#dlg');
  check(`[override] ...picker reopens with the new count`, await counter(), 'count{"n":0,"max":1}');
  check(`[override] ...header says it is adjusted`, await p.$eval('#dlg .hudtra-targets-what', e => e.textContent.includes('adjusted')), true);
  await confirm("ally");
  check(`[override] ...Healing Word cast on one creature`, (await L())[0], ["use", "hwAny", "ally"]);
  check(`[override] ...stored as the activity's rule`, await p.evaluate(() => acts.hwAny.actor.flags["dnd5e-hud-to-rule-them-all"].config.entries["i:hwAny"].target), { count: 1 });
  // It sticks: the next cast uses it without asking for it again
  await p.evaluate(() => { log.length = 0; }); await bar("hwAny");
  check(`[override] ...and is still in force on the next cast`, await counter(), 'count{"n":0,"max":1}');
  await cancel();
  // Back to automatic
  await bar("hwAny"); await p.click('#dlg .hudtra-targets-adjust'); await p.waitForSelector('#rule');
  check(`[override] editor shows the saved count`, await p.inputValue('#rule input[name=count]'), "1");
  await p.click('#rule button[data-action=reset]'); await p.waitForSelector('#dlg');
  check(`[override] Back to automatic: any number again, rule gone`, [await counter(), await p.evaluate(() => acts.hwAny.actor.flags["dnd5e-hud-to-rule-them-all"].config.entries)], ['count{"n":0,"max":"∞"}', undefined]);
  await cancel();

  await reset({ targets: ["gob"] }); await setRule("bless", { mode: "self" }); await bar("bless");
  check(`[override] mode Myself: no picker, own token targeted`, [await pickers(), (await L())[0]], [0, ["use", "bless", "me"]]);
  await reset({ targets: ["gob"] }); await setRule("pfeg", { mode: "none" }); await bar("pfeg");
  check(`[override] mode Leave targets alone: no picker, untouched`, [await pickers(), (await L())[0]], [0, ["use", "pfeg", "gob"]]);
  await reset({}); await setRule("bow", { range: 10, rangeUnits: "ft" }); await bar("bow");
  check(`[override] range 10 ft: gob at 15 ft and orc out of range`, await rows(), ["ally", "gob(out)", "orc(out)"]);
  await cancel();
  await reset({}); await setRule("bow", { range: "any" }); await bar("bow");
  check(`[override] range No limit: nobody out of range`, await rows(), ["ally", "gob", "orc"]);
  await cancel();
  await reset({}); await setRule("pfeg", { filter: "enemy" }); await bar("pfeg");
  check(`[override] who Enemies: only hostile tokens offered (touch: both beyond 5 ft)`, await rows(), ["gob(out)", "orc(out)"]);
  await cancel();
  await reset({}); await setRule("misty", { mode: "pick", count: 2 }); await bar("misty");
  check(`[override] mode Pick on Misty Step: picker for 2`, await counter(), 'count{"n":0,"max":2}');
  await cancel();
  await reset({}); await setRule("pfeg", { count: "bogus", filter: "nonsense", mode: "weird" }); await bar("pfeg");
  check(`[override] garbage in the rule is ignored, item data used`, await counter(), 'count{"n":1,"max":1}');
  await cancel();

  // The area picker opens after the cast: no Adjust there (nothing to return to)
  await reset({});
  await p.evaluate(() => {
    window.done = false;
    const plan = { kind: "area", filter: "creature", count: null, choice: true, fromSelf: true };
    const tpl = { x: 0, y: 0, object: { _computeShape: () => ({ contains: (x) => x >= 0 && x <= 260 }) } };
    T.afterUse(acts.pfeg, plan, { templates: [tpl], message: { isOwner: false } }).then(() => window.done = true);
  });
  await p.waitForSelector('#dlg');
  check(`[override] area picker after the cast has no Adjust button`, await p.$('#dlg .hudtra-targets-adjust'), null);
  await p.click('#dlg button[data-action=confirm]'); await p.waitForFunction(() => window.done);

  /* ---------------- canvas -> picker ---------------- */
  const tick = () => p.waitForTimeout(30);
  await reset({}); await bar("bless");
  await p.evaluate(() => canvasTarget("gob")); await tick();
  check(`[canvas] T on a token ticks its row`, await checked(), ["gob"]);
  await p.evaluate(() => canvasTarget("ally", { shift: true })); await tick();
  await p.evaluate(() => canvasTarget("me", { shift: true })); await tick();
  check(`[canvas] shift-T adds up to the limit`, (await checked()).sort(), ["ally", "gob", "me"]);
  await p.evaluate(() => canvasTarget("orc", { shift: true })); await tick();
  check(`[canvas] a 4th target over a limit of 3 is refused and untargeted`, [(await checked()).sort(), [...await p.evaluate(() => [...targets])].sort()], [["ally", "gob", "me"], ["ally", "gob", "me"]]);
  await p.evaluate(() => canvasTarget("gob", { off: true })); await tick();
  check(`[canvas] untargeting on the canvas unticks the row`, (await checked()).sort(), ["ally", "me"]);
  await p.evaluate(() => canvasTarget("orc")); await tick();
  check(`[canvas] T without shift replaces the selection`, [await checked(), await p.evaluate(() => [...targets])], [["orc"], ["orc"]]);
  await p.evaluate(() => canvasHover("gob", true));
  check(`[canvas] hovering a token lights its row`, await p.$$eval('#dlg li.hovered', ls => ls.map(l => l.dataset.id)), ["gob"]);
  await p.evaluate(() => canvasHover("gob", false));
  check(`[canvas] ...and leaving it clears the light`, await p.$$eval('#dlg li.hovered', ls => ls.length), 0);
  await confirm();
  check(`[canvas] the canvas choice is what gets cast`, (await L())[0], ["use", "bless", "orc"]);
  check(`[canvas] closing the picker removes its hooks`, await p.evaluate(() => hooks.filter(h => h[0] === "targetToken" || h[0] === "hoverToken").length), 0);

  await reset({}); await bar("pfeg");
  await p.evaluate(() => canvasTarget("ally")); await tick();
  check(`[canvas] one-target picker: canvas target replaces the preselect`, [await checked(), await p.evaluate(() => [...targets])], [["ally"], ["ally"]]);
  await cancel();
  check(`[canvas] cancel still restores the targets from before`, await p.evaluate(() => [...targets]), []);

  await reset({}); await setRule("pfeg", { filter: "enemy" }); await bar("pfeg");
  await p.evaluate(() => canvasTarget("ally", { shift: true })); await tick();
  check(`[canvas] a token not on the list is untargeted again`, [await checked(), await p.evaluate(() => [...targets])], [[], []]);
  await cancel();

  // multi-activity item: dnd5e's choice dialog first, then the picker for the choice
  await reset({ targets: [] });
  await p.evaluate(() => { window.choose = "bow"; window.done = false; T.useFromBar(mkItem(["pfeg", "bow"]), {}).then(() => window.done = true); });
  await p.waitForSelector('#dlg'); await confirm("gob");
  check(`[no Midi] multi-activity item: choice, picker, use`, await p.evaluate(() => log.map(e => e[0] === "use" ? e.join(":") : e[0])), ["choice", "picker", "use:bow:gob"]);
  await reset({});
  await p.evaluate(() => { window.choose = null; window.done = false; T.useFromBar(mkItem(["pfeg", "bow"]), {}).then(() => window.done = true); });
  await p.waitForFunction(() => window.done);
  check(`[no Midi] multi-activity item, choice closed: nothing used`, await p.evaluate(() => log.map(e => e[0])), ["choice"]);

  // Midi with its own auto-apply off: we apply
  await reset({ midi: true, midiApply: "off" }); await bar("pfeg"); await confirm();
  check(`[Midi, its auto-apply off] PfEG on self: we apply the effect`, await L(), [["use", "pfeg", "me"], ["effect", "me"]]);
  check('no page errors or warnings', errs, []);
  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  await b.close(); srv.close();
  process.exit(fails ? 1 : 0);
})();
