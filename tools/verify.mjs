#!/usr/bin/env node
/**
 * The checks `node --check` cannot see, all of which have broken this module at
 * least once. Run from the repo root:
 *
 *   node tools/verify.mjs
 *
 * It reads files and never writes any, so it is safe to run at any time. It does
 * NOT replace verification in a running world - it only catches the mistakes that
 * are invisible in the source and obvious in the browser console.
 */
import fs from "node:fs";
import path from "node:path";

let bad = 0;
const fail = (msg) => { console.log("FAIL  " + msg); bad++; };
const ok = (msg) => console.log("ok    " + msg);

/* 1. Import cycles between scripts/*.mjs. ESM tolerates some, but this codebase
      keeps config.mjs free of the detection precisely to avoid one - so any cycle
      appearing here means a layering rule was crossed. */
const graph = {};
for (const f of fs.readdirSync("scripts").filter(f => f.endsWith(".mjs"))) {
  const src = fs.readFileSync(path.join("scripts", f), "utf8");
  graph[f] = [...src.matchAll(/from\s+"\.\/([\w.-]+\.mjs)"/g)].map(m => m[1]);
}
const state = {};
const walk = (node, stack) => {
  if (state[node] === "done") return;
  if (state[node] === "open") return fail(`import cycle: ${[...stack, node].join(" -> ")}`);
  state[node] = "open";
  for (const dep of graph[node] ?? []) {
    if (!graph[dep]) fail(`${node} imports missing file ${dep}`);
    else walk(dep, [...stack, node]);
  }
  state[node] = "done";
};
for (const node of Object.keys(graph)) walk(node, []);
ok(`import graph acyclic (${Object.keys(graph).length} modules)`);

/* 2. Every PARTS template renders EXACTLY ONE root element. Counted with a depth
      counter rather than by balancing tags: two siblings and zero roots both throw
      "Template part ... must render a single HTML element", and the application
      then never appears at all. */
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr"]);
for (const file of fs.readdirSync("templates")) {
  const src = fs.readFileSync(path.join("templates", file), "utf8")
    .replace(/\{\{![\s\S]*?\}\}/g, "");   // handlebars comments may contain markup
  let depth = 0;
  let roots = 0;
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attrs, selfClosing] = m;
    if (closing) { depth--; continue; }
    if (depth === 0) roots++;
    if (!VOID_TAGS.has(tag.toLowerCase()) && !selfClosing && !attrs.endsWith("/")) depth++;
  }
  if (roots === 1) ok(`${file}: exactly one root element`);
  else fail(`${file}: ${roots} root elements (must be exactly 1)`);
}

/* 3. Every data-action has a handler. A button wired to nothing looks completely
      normal and simply does nothing when clicked. */
const handlers = new Set();
for (const file of fs.readdirSync("scripts").filter(f => f.endsWith(".mjs"))) {
  const src = fs.readFileSync(path.join("scripts", file), "utf8");
  const block = src.match(/actions:\s*\{([\s\S]*?)\n\s{4}\}/);
  if (block) for (const m of block[1].matchAll(/^\s*(\w+):/gm)) handlers.add(m[1]);
}
let unhandled = 0;
for (const file of fs.readdirSync("templates")) {
  const src = fs.readFileSync(path.join("templates", file), "utf8");
  for (const m of src.matchAll(/data-action="([\w-]+)"/g)) {
    if (!handlers.has(m[1])) { fail(`${file}: data-action="${m[1]}" has no handler`); unhandled++; }
  }
}
if (!unhandled) ok(`every data-action has a handler (${handlers.size} declared)`);

/* 4. No i18n key is both a leaf and a branch. Foundry expands the dotted keys into a
      nested object, so shipping "x.attack" AND "x.attack.yes" asks one key to be a
      string and an object at once - which takes down the WHOLE translation table,
      not just that key. JSON.parse cannot see it. */
const lang = JSON.parse(fs.readFileSync("lang/en.json", "utf8"));
const keys = Object.keys(lang);
let shadowed = 0;
for (const key of keys) {
  const branch = keys.find(other => other !== key && other.startsWith(key + "."));
  if (branch) { fail(`i18n key is both leaf and branch: "${key}" vs "${branch}"`); shadowed++; }
}
if (!shadowed) ok(`no i18n key shadows another (${keys.length} keys)`);

/* 5. Every i18n key referenced with a static literal actually exists. Interpolated
      keys (`${MODULE_ID}.pool.${key}`) cannot be checked here and are skipped. */
const PREFIX = "dnd5e-hud-to-rule-them-all.";
const known = new Set(keys);
let missing = 0;
for (const dir of ["scripts", "templates"]) {
  for (const file of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    const seen = new Set();
    for (const m of src.matchAll(/`\$\{MODULE_ID\}\.([\w.]+)`/g)) seen.add(PREFIX + m[1]);
    for (const m of src.matchAll(/"(dnd5e-hud-to-rule-them-all\.[\w.]+)"/g)) seen.add(m[1]);
    for (const key of seen) {
      if (!known.has(key)) { fail(`${dir}/${file}: i18n key "${key}" is not in lang/en.json`); missing++; }
    }
  }
}
if (!missing) ok("every statically referenced i18n key exists");

console.log(bad ? `\n${bad} problem(s)` : "\nall checks passed");
process.exit(bad ? 1 : 0);
