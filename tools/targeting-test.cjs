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
  const reset = (o = {}) => p.evaluate(o => { log.length = 0; targets = new Set(o.targets ?? []); midi.active = !!o.midi; midi.autoItemEffects = o.midiApply ?? "applyRemove"; settings.targetPicker = o.mode ?? "always"; toks.forEach(t => t.actor.effects.list = []); }, o);
  const define = (id, o) => p.evaluate(([id, o]) => { acts[id] = mkAct(id, o); }, [id, o]);
  // click on the bar: starts useFromBar, returns once a picker is up (or it finished)
  const bar = async (id, opts = {}) => { await p.evaluate(([id, shift]) => { window.done = false; T.useFromBar(acts[id], { shiftKey: shift }).then(() => window.done = true); }, [id, !!opts.shift]); await p.waitForFunction(() => window.done || document.getElementById('dlg')); };
  const sheet = async (id, opts = {}) => { await p.evaluate(([id, shift]) => { window.done = false; acts[id].use({ event: { shiftKey: shift } }).then(() => window.done = true); }, [id, !!opts.shift]); await p.waitForTimeout(50); await p.waitForFunction(() => window.done || document.getElementById('dlg')); };
  const checked = () => p.$$eval('#dlg input:checked', i => i.map(x => x.value));
  const confirm = async (pick) => { if (pick) { await p.click(`#dlg li[data-id=${pick}] input`); } await p.click('#dlg button[data-action=confirm]'); await p.waitForFunction(() => window.done); await p.waitForTimeout(50); };
  const L = () => p.evaluate(() => log.filter(e => e[0] !== "picker"));
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
