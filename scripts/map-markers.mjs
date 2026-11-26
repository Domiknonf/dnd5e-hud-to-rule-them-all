import { MODULE_ID } from "./const.mjs";
import { requestFromGM } from "./socket.mjs";

/**
 * Map markers.
 *
 * Double-click / double-tap an empty spot of the scene (Token layer) to open a small
 * radial menu, pick an icon, and the marker appears for everyone at once. Right after
 * placing it the menu turns into an optional name field. Double-clicking a marker opens
 * the same menu to change its icon, rename it or remove it.
 *
 * Markers live in a scene flag (flags.<module>.mapMarkers.<id>). Players cannot update
 * scenes themselves, so their changes go to the active GM over the module socket
 * (socket.mjs routes "mapMarker" here) and are written there. That is why a GM has to
 * be online for players.
 */

const FLAG = "mapMarkers";
/** Radial order, clockwise from the top. */
const TYPES = ["pin", "skull", "question", "chest", "sword"];
const MAX_LABEL = 60;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 24;
/** Markers never shrink below this on screen, so they stay findable on a big, zoomed-out map. */
const MIN_SCREEN_PX = 32;
/** On-screen size while "show all markers" is on. */
const SPOTLIGHT_SCREEN_PX = 60;

const iconPath = (type) => `modules/${MODULE_ID}/assets/map-markers/${type}.svg`;
const setting = (key) => game.settings.get(MODULE_ID, key);

/* -------------------------------------------- */
/*  Data                                        */
/* -------------------------------------------- */

function getMarkers(scene = canvas.scene) {
  const raw = scene?.getFlag(MODULE_ID, FLAG) ?? {};
  return Object.values(raw).filter((m) => m && TYPES.includes(m.type));
}

function sanitize(m) {
  if (!m || typeof m.id !== "string" || !/^[A-Za-z0-9]{16}$/.test(m.id)) return null;
  const x = Number(m.x);
  const y = Number(m.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!TYPES.includes(m.type)) return null;
  return {
    id: m.id,
    x: Math.round(x),
    y: Math.round(y),
    type: m.type,
    label: String(m.label ?? "").trim().slice(0, MAX_LABEL),
    author: typeof m.author === "string" ? m.author : null,
    created: Number(m.created) || Date.now()
  };
}

function userMayEdit(user, marker) {
  return user.isGM || setting("mapMarkersEditAll") || marker.author === user.id;
}

function userMayPlace(user) {
  return user.isGM || setting("mapMarkersPlayers");
}

/* -------------------------------------------- */
/*  Writes (GM side) and relay (player side)    */
/* -------------------------------------------- */

/** GM-side writes run one after another so a rename never overtakes its create. */
let writeQueue = Promise.resolve();

function applyWrite(action, payload, userId) {
  writeQueue = writeQueue
    .then(() => doWrite(action, payload, userId))
    .catch((err) => console.error(`${MODULE_ID} | map marker write failed`, err));
  return writeQueue;
}

async function doWrite(action, payload = {}, userId) {
  const scene = game.scenes.get(payload.sceneId);
  const user = game.users.get(userId);
  if (!scene || !user) return;
  const markers = scene.getFlag(MODULE_ID, FLAG) ?? {};
  const key = (id) => `flags.${MODULE_ID}.${FLAG}.${id}`;

  switch (action) {
    case "create": {
      if (!setting("mapMarkers") || !userMayPlace(user)) return;
      const marker = sanitize({ ...payload.marker, author: user.id, created: Date.now() });
      if (!marker || markers[marker.id]) return;
      return scene.update({ [key(marker.id)]: marker });
    }
    case "update": {
      const current = markers[payload.markerId];
      if (!current || !userMayEdit(user, current)) return;
      const changes = {};
      if ("type" in (payload.changes ?? {})) changes.type = payload.changes.type;
      if ("label" in (payload.changes ?? {})) changes.label = payload.changes.label;
      const next = sanitize({ ...current, ...changes });
      if (!next) return;
      return scene.update({ [key(next.id)]: next });
    }
    case "delete": {
      const current = markers[payload.markerId];
      if (!current || !userMayEdit(user, current)) return;
      return scene.update({ [`flags.${MODULE_ID}.${FLAG}.-=${current.id}`]: null });
    }
  }
}

/**
 * GM side of the relay, called by socket.mjs for a "mapMarker" message. The sender id
 * Foundry passes along is trusted over the one in the payload.
 */
export function applyMarkerRequest(data = {}, senderId) {
  const userId = typeof senderId === "string" && game.users.get(senderId) ? senderId : data.userId;
  return applyWrite(data.op, data, userId);
}

function request(op, payload) {
  if (game.user.isGM) {
    applyWrite(op, payload, game.user.id);
    return true;
  }
  return requestFromGM("mapMarker", { op, ...payload, userId: game.user.id });
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

let layer = null;
/** Name of our container on the canvas, so strays from an earlier draw can be found. */
const LAYER_NAME = `${MODULE_ID}:map-markers-layer`;

/**
 * Remove every marker container on the canvas except `keep`. Foundry does not tear our
 * container down with the scene's own layers, so after a canvas redraw the old one
 * stayed behind - frozen at its old zoom scale - and the marker was drawn twice.
 */
function purgeLayers(keep = null) {
  const parents = new Set([canvas.interface, layer?.parent].filter(Boolean));
  for (const parent of parents) {
    for (const child of [...(parent.children ?? [])]) {
      if (child.name !== LAYER_NAME || child === keep) continue;
      parent.removeChild(child);
      if (!child.destroyed) child.destroy({ children: true });
    }
  }
  if (layer && layer !== keep) {
    if (layer.parent) layer.parent.removeChild(layer);
    if (!layer.destroyed) layer.destroy({ children: true });
    layer = null;
  }
}

function countLayers() {
  return (canvas.interface?.children ?? []).filter((c) => c.name === LAYER_NAME).length;
}
let drawSeq = 0;
/** Marker ids already shown on this client for the current scene, to animate only new ones. */
let seen = new Set();
/** What is on the canvas right now, by marker id: { marker, container, ring, pop }. */
let drawn = new Map();
const textures = {};

/**
 * The icon textures belong to this module alone. Going through Foundry's loadTexture
 * put them in its texture cache, which destroys the least recently used entries once
 * it is full - typically after a scene change or a big map loaded - and the markers
 * then drew as nothing until a reload. An Image we load ourselves is never evicted.
 */
function textureOk(tex) {
  return !!tex && !tex.destroyed && !tex.baseTexture?.destroyed && tex.valid !== false;
}

async function loadTextures() {
  for (const type of TYPES) {
    if (textureOk(textures[type])) continue;
    const img = new Image();
    img.src = iconPath(type);
    await img.decode();
    textures[type] = new PIXI.Texture(new PIXI.BaseTexture(img));
  }
}

function markerSize() {
  return (canvas.grid?.size ?? 100) * (setting("mapMarkersScale") ?? 0.8);
}

/**
 * Extra scale on top of the marker's own size, so it keeps a minimum size on screen
 * however far the map is zoomed out (and a larger one while the spotlight is on).
 */
function zoomFactor() {
  const onScreen = markerSize() * (canvas.stage?.scale?.x ?? 1);
  const min = spotlightOn() ? SPOTLIGHT_SCREEN_PX : MIN_SCREEN_PX;
  return Math.max(1, min / Math.max(onScreen, 1));
}

function applyScale() {
  const k = zoomFactor();
  for (const d of drawn.values()) {
    if (!d.container.destroyed) d.container.scale.set(k * d.pop);
  }
}

async function draw({ initial = false } = {}) {
  if (!canvas.ready || !canvas.scene) return;
  const seq = ++drawSeq;
  try {
    await loadTextures();
  } catch (err) {
    // The health check below tries again in a few seconds.
    console.warn(`${MODULE_ID} | map marker icons failed to load`, err);
    return;
  }
  if (seq !== drawSeq || !canvas.ready) return;

  if (!layer || layer.destroyed || layer.parent !== canvas.interface) {
    purgeLayers();
    layer = new PIXI.Container();
    layer.name = LAYER_NAME;
    layer.eventMode = "none";
    layer.zIndex = 1000;
    canvas.interface.addChild(layer);
  }
  purgeLayers(layer);
  for (const child of layer.removeChildren()) child.destroy({ children: true });
  drawn = new Map();

  const size = markerSize();
  const TextClass = foundry.canvas?.containers?.PreciseText ?? globalThis.PreciseText ?? PIXI.Text;
  const markers = getMarkers().sort((a, b) => a.created - b.created);

  for (const m of markers) {
    const container = new PIXI.Container();
    container.position.set(m.x, m.y);

    // Pulsing ring, only visible while "show all markers" is on.
    const ring = new PIXI.Graphics();
    ring.lineStyle?.(size * 0.07, 0xffd36b, 1);
    ring.drawCircle?.(0, 0, size * 0.62);
    ring.visible = spotlightOn();
    container.addChild(ring);

    const sprite = new PIXI.Sprite(textures[m.type]);
    sprite.anchor.set(0.5);
    sprite.width = sprite.height = size;
    container.addChild(sprite);

    if (m.label) {
      const style = CONFIG.canvasTextStyle.clone();
      style.fontSize = Math.max(14, Math.round(size * 0.3));
      style.align = "center";
      style.wordWrap = true;
      style.wordWrapWidth = size * 3;
      const text = new TextClass(m.label, style);
      text.anchor.set(0.5, 0);
      text.position.set(0, size / 2 + 4);
      container.addChild(text);
    }

    layer.addChild(container);
    const entry = { marker: m, container, ring, sprite, pop: 1 };
    drawn.set(m.id, entry);
    if (!initial && !seen.has(m.id)) popIn(entry);
    seen.add(m.id);
  }
  applyScale();
  refreshSpotlight();
}

function popIn(entry) {
  const ticker = canvas.app.ticker;
  const start = performance.now();
  const duration = 260;
  entry.pop = 0.2;
  const step = () => {
    if (entry.container.destroyed) return ticker.remove(step);
    const p = Math.min(1, (performance.now() - start) / duration);
    // Ease out with a small overshoot.
    const s = 1 + 2.2 * Math.pow(p - 1, 3) + 1.2 * Math.pow(p - 1, 2);
    entry.pop = p >= 1 ? 1 : 0.2 + 0.8 * s;
    entry.container.scale.set(zoomFactor() * entry.pop);
    if (p >= 1) ticker.remove(step);
  };
  ticker.add(step);
}

/* -------------------------------------------- */
/*  Show all markers (spotlight)                */
/* -------------------------------------------- */

/** Held key (M by default) and the toggle button in the token controls, independently. */
let spotlightKey = false;
let spotlightToggle = false;
let pulse = null;
let edgeRoot = null;

function spotlightOn() {
  return (spotlightKey || spotlightToggle) && setting("mapMarkers");
}

/** Bring rings, scale, pulse and the edge arrows in line with the spotlight state. */
function refreshSpotlight() {
  const on = spotlightOn() && canvas.ready;
  for (const d of drawn.values()) d.ring.visible = on;
  applyScale();

  const ticker = canvas.app?.ticker;
  if (on && !pulse && ticker) {
    pulse = () => {
      const a = 0.55 + 0.45 * Math.sin(performance.now() / 170);
      for (const d of drawn.values()) d.ring.alpha = a;
    };
    ticker.add(pulse);
  } else if (!on && pulse) {
    ticker?.remove(pulse);
    pulse = null;
  }
  updateEdges();
}

function toClient(point) {
  if (typeof canvas.clientCoordinatesFromCanvas === "function") return canvas.clientCoordinatesFromCanvas(point);
  const rect = canvas.app.view.getBoundingClientRect();
  const p = canvas.stage.worldTransform.apply(new PIXI.Point(point.x, point.y));
  return { x: p.x + rect.left, y: p.y + rect.top };
}

/**
 * While the spotlight is on, every marker outside the visible part of the map gets an
 * arrow with its icon at the screen edge, pointing towards it. Clicking one pans there.
 */
function updateEdges() {
  if (!spotlightOn() || !canvas.ready) {
    edgeRoot?.remove();
    edgeRoot = null;
    return;
  }
  if (!edgeRoot) {
    edgeRoot = document.createElement("div");
    edgeRoot.className = "qmm-edges";
    edgeRoot.addEventListener("click", (ev) => {
      const el = ev.target.closest(".qmm-edge");
      if (el) canvas.animatePan({ x: Number(el.dataset.x), y: Number(el.dataset.y), duration: 400 });
    });
    document.body.append(edgeRoot);
  }

  // The part of the board not covered by the controls, the sidebar and the bottom bar.
  const board = canvas.app.view.getBoundingClientRect();
  const sidebar = ui.sidebar?.element?.getBoundingClientRect?.()?.width ?? 0;
  const box = {
    left: board.left + 90,
    top: board.top + 40,
    right: Math.max(board.left + 200, board.right - sidebar - 40),
    bottom: Math.max(board.top + 200, board.bottom - 160)
  };
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;

  const items = [];
  for (const { marker } of drawn.values()) {
    const p = toClient(marker);
    if (p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom) continue;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const tx = dx ? ((dx > 0 ? box.right : box.left) - cx) / dx : Infinity;
    const ty = dy ? ((dy > 0 ? box.bottom : box.top) - cy) / dy : Infinity;
    const t = Math.min(tx, ty);

    const el = document.createElement("div");
    el.className = "qmm-edge";
    el.style.left = `${cx + dx * t}px`;
    el.style.top = `${cy + dy * t}px`;
    el.style.setProperty("--qmm-angle", `${Math.atan2(dy, dx)}rad`);
    el.dataset.x = marker.x;
    el.dataset.y = marker.y;
    el.dataset.tooltip = marker.label || game.i18n.localize(`${MODULE_ID}.mapMarkers.type.${marker.type}`);
    const arrow = document.createElement("span");
    arrow.className = "qmm-edge-arrow";
    const img = document.createElement("img");
    img.src = iconPath(marker.type);
    img.alt = "";
    el.append(arrow, img);
    items.push(el);
  }
  edgeRoot.replaceChildren(...items);
}

Hooks.once("init", () => {
  game.keybindings.register(MODULE_ID, "mapMarkersSpotlight", {
    name: `${MODULE_ID}.keybindings.mapMarkersSpotlight.name`,
    hint: `${MODULE_ID}.keybindings.mapMarkersSpotlight.hint`,
    editable: [{ key: "KeyM" }],
    onDown: () => {
      if (!setting("mapMarkers") || !canvas.ready) return false;
      spotlightKey = true;
      refreshSpotlight();
      return true;
    },
    onUp: () => {
      if (!spotlightKey) return false;
      spotlightKey = false;
      refreshSpotlight();
      return true;
    }
  });
});

/** Toggle in the token controls: the same spotlight, for touch screens and for leaving it on. */
Hooks.on("getSceneControlButtons", (controls) => {
  if (!setting("mapMarkers")) return;
  const tokens = controls.tokens;
  if (!tokens?.tools) return;
  tokens.tools.mapMarkersSpotlight = {
    name: "mapMarkersSpotlight",
    title: `${MODULE_ID}.mapMarkers.spotlight`,
    icon: "fa-solid fa-map-location-dot",
    order: Object.keys(tokens.tools).length + 1,
    toggle: true,
    active: spotlightToggle,
    onChange: (event, active) => {
      spotlightToggle = !!active;
      refreshSpotlight();
    }
  };
});

/** Redraw from scratch, e.g. after the size or the on/off setting changed. */
export function redrawMapMarkers() {
  ui.controls?.render({ reset: true });
  if (!setting("mapMarkers")) {
    drawSeq++; // drop a draw still waiting for its textures
    closeMenu();
    purgeLayers();
    drawn = new Map();
    refreshSpotlight();
    return;
  }
  draw({ initial: true });
}

Hooks.on("canvasReady", () => {
  purgeLayers();
  drawn = new Map();
  seen = new Set();
  bindInput();
  if (setting("mapMarkers")) draw({ initial: true });
});

Hooks.on("canvasTearDown", () => {
  closeMenu();
  purgeLayers();
  drawn = new Map();
  if (pulse) canvas.app?.ticker.remove(pulse);
  pulse = null;
  edgeRoot?.remove();
  edgeRoot = null;
});

/* -------------------------------------------- */
/*  Self-healing                                */
/* -------------------------------------------- */

/**
 * Whether what is drawn still matches the scene: our container still on the canvas,
 * every icon texture alive, and one sprite per stored marker. Anything that tears a
 * piece out from under us (a texture evicted, the interface group rebuilt, a draw that
 * failed) shows up here, and the markers are redrawn instead of staying gone until
 * the next reload.
 */
function isHealthy() {
  if (!layer || layer.destroyed || layer.parent !== canvas.interface) return false;
  if (countLayers() !== 1) return false;
  const markers = getMarkers();
  if (markers.length !== drawn.size) return false;
  for (const m of markers) {
    const d = drawn.get(m.id);
    if (!d || d.container.destroyed || !d.container.parent) return false;
    if (d.marker.type !== m.type || d.marker.label !== m.label || d.marker.x !== m.x || d.marker.y !== m.y) return false;
    if (!d.sprite || d.sprite.destroyed || !textureOk(d.sprite.texture)) return false;
  }
  return true;
}

let healing = false;
async function heal() {
  if (healing || !canvas.ready || !canvas.scene || !setting("mapMarkers")) return;
  if (isHealthy()) return;
  healing = true;
  try {
    await draw({ initial: true });
  } finally {
    healing = false;
  }
}

Hooks.once("ready", () => setInterval(heal, 3000));

Hooks.on("canvasPan", () => {
  heal();
  applyScale();
  if (spotlightOn()) updateEdges();
});

Hooks.on("updateScene", (scene, changes) => {
  if (scene.id !== canvas.scene?.id || !setting("mapMarkers")) return;
  // Deletions arrive as "-=<id>" keys under our flag, so look for the flag key itself.
  const ours = changes.flags?.[MODULE_ID];
  if (!ours || !Object.keys(ours).some((k) => k === FLAG || k === `-=${FLAG}`)) return;
  draw();
});

/* -------------------------------------------- */
/*  Input                                       */
/* -------------------------------------------- */

let boundView = null;
let lastTap = null;

function bindInput() {
  const view = canvas.app?.view;
  if (!view || view === boundView) return;
  boundView = view;
  view.addEventListener("pointerdown", onPointerDown);
}

function onPointerDown(event) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const now = performance.now();
  const prev = lastTap;
  lastTap = { time: now, x: event.clientX, y: event.clientY };
  if (!prev) return;
  if (now - prev.time > DOUBLE_TAP_MS) return;
  if (Math.hypot(event.clientX - prev.x, event.clientY - prev.y) > DOUBLE_TAP_PX) return;
  lastTap = null;
  onDoubleTap(event);
}

function toCanvas(event) {
  const client = { x: event.clientX, y: event.clientY };
  if (typeof canvas.canvasCoordinatesFromClient === "function") return canvas.canvasCoordinatesFromClient(client);
  const rect = canvas.app.view.getBoundingClientRect();
  return canvas.stage.worldTransform.applyInverse(new PIXI.Point(client.x - rect.left, client.y - rect.top));
}

function markerAt(point) {
  const radius = (markerSize() * zoomFactor()) / 2;
  const hits = getMarkers().filter((m) => Math.hypot(m.x - point.x, m.y - point.y) <= radius);
  return hits.sort((a, b) => b.created - a.created)[0] ?? null;
}

function tokenAt(point) {
  return canvas.tokens.placeables.some((tok) => tok.visible && tok.bounds?.contains(point.x, point.y));
}

function onDoubleTap(event) {
  if (!canvas.ready || !canvas.scene || menu || !setting("mapMarkers")) return;
  if (canvas.activeLayer !== canvas.tokens) return;
  const point = toCanvas(event);

  const marker = markerAt(point);
  if (marker) {
    if (!userMayEdit(game.user, marker)) return ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.mapMarkers.noPermission`));
    return openMenu(event, { marker });
  }

  if (!userMayPlace(game.user)) return;
  if (tokenAt(point)) return;
  if (!canvas.dimensions.rect.contains(point.x, point.y)) return;
  openMenu(event, { point });
}

/* -------------------------------------------- */
/*  Radial menu                                 */
/* -------------------------------------------- */

let menu = null;

function closeMenu() {
  if (!menu) return;
  menu.cleanup();
  menu.element.remove();
  menu = null;
}

function openMenu(event, { point = null, marker = null }) {
  closeMenu();
  const sceneId = canvas.scene.id;
  const editing = !!marker;

  const root = document.createElement("div");
  root.className = "qmm-menu";
  root.classList.toggle("is-editing", editing);

  const pie = document.createElement("div");
  pie.className = "qmm-pie";
  TYPES.forEach((type, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "qmm-slice";
    // Evenly round the pie, clockwise from the top.
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / TYPES.length;
    button.style.left = `${100 + 66 * Math.cos(angle) - 29}px`;
    button.style.top = `${100 + 66 * Math.sin(angle) - 29}px`;
    button.classList.toggle("is-current", marker?.type === type);
    button.dataset.type = type;
    button.dataset.tooltip = game.i18n.localize(`${MODULE_ID}.mapMarkers.type.${type}`);
    button.setAttribute("aria-label", game.i18n.localize(`${MODULE_ID}.mapMarkers.type.${type}`));
    const img = document.createElement("img");
    img.src = iconPath(type);
    img.alt = "";
    button.append(img);
    pie.append(button);
  });
  const center = document.createElement("button");
  center.type = "button";
  center.className = "qmm-center";
  center.dataset.action = editing ? "delete" : "close";
  center.dataset.tooltip = game.i18n.localize(editing ? `${MODULE_ID}.mapMarkers.delete` : `${MODULE_ID}.mapMarkers.close`);
  center.setAttribute("aria-label", center.dataset.tooltip);
  center.innerHTML = `<i class="fa-solid ${editing ? "fa-trash" : "fa-xmark"}"></i>`;
  pie.append(center);

  const form = document.createElement("form");
  form.className = "qmm-name";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = MAX_LABEL;
  input.placeholder = game.i18n.localize(`${MODULE_ID}.mapMarkers.namePlaceholder`);
  input.value = marker?.label ?? "";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "qmm-save";
  save.dataset.tooltip = game.i18n.localize(`${MODULE_ID}.mapMarkers.save`);
  save.setAttribute("aria-label", game.i18n.localize(`${MODULE_ID}.mapMarkers.save`));
  save.innerHTML = `<i class="fa-solid fa-check"></i>`;
  form.append(input, save);

  root.append(pie, form);
  document.body.append(root);

  // Keep the whole menu on screen.
  const half = 110;
  const x = Math.min(Math.max(event.clientX, half), window.innerWidth - half);
  const y = Math.min(Math.max(event.clientY, half), window.innerHeight - half - 60);
  root.style.left = `${x}px`;
  root.style.top = `${y}px`;

  // The marker this menu is about: the existing one, or the one just placed.
  let markerId = marker?.id ?? null;

  pie.addEventListener("click", (ev) => {
    const button = ev.target.closest("button");
    if (!button) return;
    if (button.dataset.action === "close") return closeMenu();
    if (button.dataset.action === "delete") {
      request("delete", { sceneId, markerId });
      return closeMenu();
    }
    const type = button.dataset.type;
    if (editing) {
      request("update", { sceneId, markerId, changes: { type, label: input.value } });
      return closeMenu();
    }
    markerId = foundry.utils.randomID(16);
    const ok = request("create", { sceneId, marker: { id: markerId, x: point.x, y: point.y, type, label: "" } });
    if (!ok) return closeMenu();
    // Placed - now offer the optional name.
    root.classList.add("is-naming");
    input.focus();
  });

  /** Save a typed name. Runs on Enter / the check button, and when clicking away while naming. */
  const commitName = () => {
    const label = input.value.trim();
    if (markerId && (editing ? label !== (marker.label ?? "") : label)) {
      request("update", { sceneId, markerId, changes: { label } });
    }
  };

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    commitName();
    closeMenu();
  });

  const onOutside = (ev) => {
    if (root.contains(ev.target)) return;
    if (root.classList.contains("is-naming")) commitName();
    closeMenu();
  };
  const onKey = (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    closeMenu();
  };
  // Defer so the pointerdown that opened the menu does not close it again.
  const timer = setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
  document.addEventListener("keydown", onKey, true);

  menu = {
    element: root,
    cleanup: () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
    }
  };

  // Mouse users can type straight away when editing; on touch this would pop the keyboard.
  if (editing && event.pointerType === "mouse") input.focus();
}
