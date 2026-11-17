# Quick Map Markers

A tiny Foundry VTT v13 module: **double-click (or double-tap) an empty spot of the scene**, a small
radial menu opens, pick a **skull, question mark, treasure chest or sword**, and the marker shows up
for everyone at once. Right after placing it you can give it a name (optional: Enter saves, clicking
away keeps what you typed).

**Double-click an existing marker** to change its icon, rename it, or remove it (trash button in the middle).

- Works on the Token layer (the default layer for players).
- Markers are drawn above the fog of war, so everyone sees them, explored or not.
- Stored on the scene. No journals, no core Note permissions needed.
- Players' changes go through the GM's client, so **a GM has to be online** for players to place markers.

## Settings
| Setting | Default |
|---|---|
| Players can place markers | on |
| Everyone can edit every marker (otherwise only your own; GMs always can) | off |
| Marker size (relative to a grid square) | 0.8 |

## Install
Copy this folder to `Data/modules/quick-map-markers` on your Foundry server (or unzip
`quick-map-markers.zip` there), restart/refresh Foundry, and enable **Quick Map Markers** in the world.

## Clearing all markers of a scene (macro)
```js
canvas.scene.unsetFlag("quick-map-markers", "markers");
```
