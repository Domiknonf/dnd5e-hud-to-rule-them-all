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
/** Radial order: top, right, bottom, left. */
const TYPES = ["skull", "question", "chest", "sword"];
const SLOTS = ["n", "e", "s", "w"];
const MAX_LABEL = 60;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 24;

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
let drawSeq = 0;
/** Marker ids already shown on this client for the current scene, to animate only new ones. */
let seen = new Set();
const textures = {};

async function loadTextures() {
  const load = foundry.canvas?.loadTexture ?? globalThis.loadTexture;
  for (const type of TYPES) {
    if (!textures[type] || textures[type].destroyed) textures[type] = await load(iconPath(type));
  }
}

function markerSize() {
  return (canvas.grid?.size ?? 100) * (setting("mapMarkersScale") ?? 0.8);
}

async function draw({ initial = false } = {}) {
  if (!canvas.ready || !canvas.scene) return;
  const seq = ++drawSeq;
  await loadTextures();
  if (seq !== drawSeq || !canvas.ready) return;

  if (!layer || layer.destroyed || !layer.parent) {
    layer = new PIXI.Container();
    layer.eventMode = "none";
    layer.zIndex = 1000;
    canvas.interface.addChild(layer);
  }
  for (const child of layer.removeChildren()) child.destroy({ children: true });

  const size = markerSize();
  const TextClass = foundry.canvas?.containers?.PreciseText ?? globalThis.PreciseText ?? PIXI.Text;
  const markers = getMarkers().sort((a, b) => a.created - b.created);

  for (const m of markers) {
    const container = new PIXI.Container();
    container.position.set(m.x, m.y);

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
    if (!initial && !seen.has(m.id)) popIn(container);
    seen.add(m.id);
  }
}

function popIn(container) {
  const ticker = canvas.app.ticker;
  const start = performance.now();
  const duration = 260;
  container.scale.set(0.2);
  const step = () => {
    if (container.destroyed) return ticker.remove(step);
    const p = Math.min(1, (performance.now() - start) / duration);
    // Ease out with a small overshoot.
    const s = 1 + 2.2 * Math.pow(p - 1, 3) + 1.2 * Math.pow(p - 1, 2);
    container.scale.set(0.2 + 0.8 * s);
    if (p >= 1) {
      container.scale.set(1);
      ticker.remove(step);
    }
  };
  ticker.add(step);
}

/** Redraw from scratch, e.g. after the size or the on/off setting changed. */
export function redrawMapMarkers() {
  if (!setting("mapMarkers")) {
    drawSeq++; // drop a draw still waiting for its textures
    closeMenu();
    layer?.destroy({ children: true });
    layer = null;
    return;
  }
  draw({ initial: true });
}

Hooks.on("canvasReady", () => {
  layer = null;
  seen = new Set();
  bindInput();
  if (setting("mapMarkers")) draw({ initial: true });
});

Hooks.on("canvasTearDown", () => {
  closeMenu();
  layer = null;
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
  const radius = markerSize() / 2;
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
    button.className = `qmm-slice qmm-${SLOTS[i]}`;
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
