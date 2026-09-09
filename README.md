# 💗 Kokoro2D

<p align="center">
  <strong>make the anime girl. bend the anime girl. give the anime girl microphone access. what could go wrong</strong><br>
  an original browser-native 2D VTuber maker + viewer, because apparently we own a rendering engine now
</p>

<p align="center">
  <img alt="WebGL2" src="https://img.shields.io/badge/WebGL2-summoned-ff69b4?style=flat">
  <img alt="Dependencies" src="https://img.shields.io/badge/runtime_dependencies-zero-9f7aea?style=flat">
  <img alt="Schema" src="https://img.shields.io/badge/kokoro2d_schema-v1-f58bd4?style=flat">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-6fe2ba?style=flat">
  <img alt="Status" src="https://img.shields.io/badge/status-alpha%20but%20she%20moves-ff8ed8?style=flat">
</p>

---

ok so. hear me out 🥂

we took separated character artwork, put little triangle meshes all over it,
added parameter keyforms, handed the whole situation to WebGL2, and now the
drawing has opinions about where your cursor is. this was SUPPOSED to be a
small technical prototype. she has a file format now. she has physics settings.
she has a standalone viewer. i think we accidentally incorporated her

Kokoro2D is an experimental 2D VTuber Maker and Viewer that runs directly in a
modern browser. the model format is ours. the renderer is ours. the bugs are
also ours, lovingly handcrafted, locally sourced, and currently being watched
very closely 👁️

## NEW: hand her one PNG and walk away dramatically

the Maker now contains a **Full Auto Rigger**. click `✨ Auto-rig PNG`, give it
one front-facing anime portrait, and the browser will—LOCALLY, with no upload
and no mysterious cloud bucket named `definitely-not-your-waifu`—attempt to:

- remove a flat or transparent background;
- find the character silhouette;
- estimate the face from connected skin regions;
- locate both eyes and the mouth using weighted visual features;
- preserve the original portrait as the neutral pose;
- synthesize matching eyelid and mouth-interior surfaces for animation;
- generate a dense deformable body/head mesh;
- author head yaw, pitch, roll, body sway, hair motion, blink, mouth-open,
  and mouth-form keyforms; and
- open the finished puppet directly in the normal Maker.

it also gives you a confidence score and says which guesses deserve human eyes.
front-facing characters on simple or transparent backgrounds work best.
complicated poses, hands over faces, dramatic three-quarter views, and seventeen
kilometres of foreground hair may require mesh correction afterward because the
software is brave but it has not achieved enlightenment

> **project status**
>
> renderer: alive<br>
> puppet: blinking<br>
> microphone permission: an intimate level of trust<br>
> runtime dependencies: NONE. zero. the cupboard is EMPTY<br>
> production readiness: babe please read the alpha warning

## start the tiny nightclub

```bash
cd /Users/ethan/playground/kokoro2D
npm start
```

then open:

- **Maker:** <http://localhost:5173>
- **Viewer:** <http://localhost:5173/viewer.html>

do not open the HTML through `file://`. browser ES modules will see this, become
offended on a spiritual level, and refuse to cooperate. use the server. the
server is three words. we can do this together

## what even is this

Kokoro2D currently proves that one understandable, dependency-free codebase can
handle:

- layered character artwork;
- deformable textured meshes;
- parameter keyforms and interpolation;
- procedural head, body, eye, mouth, blink, and hair performance;
- microphone-driven mouth movement;
- portable self-contained puppet files;
- a Maker and Viewer that agree on what all those words mean; and
- automatic single-image rigging without sending the artwork off-device.

the important bit is that this is **not** a Live2D `.moc3` decoder wearing a
fake moustache. it is an original model format and renderer. existing character
art can be re-rigged here when you have the source layers and the artist's
permission. the proprietary compiled rig stays over there. we wave politely
from a legally comfortable distance

## make a creature (responsibly-ish)

0. Or click **✨ Auto-rig PNG** and let the machine perform the following steps
   while you supervise with the calm authority of someone holding a drink.
1. Click the **+** in Layers and import separated PNG, WebP, JPEG, or SVG art.
2. Select a layer. whisper something encouraging. adjust its base transform.
3. Choose a parameter such as Head Yaw, Eye Blink, or Mouth Open.
4. Move the parameter away from its default value.
5. Create a keyform at that value.
6. Transform the layer or drag its mesh points directly on the stage.
7. Hit **Animate preview** and discover whether you made a VTuber or a beautiful
   new cryptid.
8. Export the result as a `.kokoro2d` file.

the editor autosaves to browser local storage because losing a rig is how
villain origin stories begin. `Cmd/Ctrl+Z`, redo, and `Cmd/Ctrl+S` work too.
we may be chaotic but we are not monsters

## the Viewer, aka containment window

the standalone Viewer includes:

- WebGL2 textured triangle rendering;
- additive parameter and keyform evaluation;
- procedural idle performance;
- springy secondary hair motion;
- pointer-directed gaze (she knows where you are);
- optional microphone lip sync;
- transparent canvas output for future OBS integration; and
- loading models exported by the Maker, which sounds obvious until you have
  written a file format at 1:17 in the morning.

touching a parameter slider pauses the demo so you can inspect a pose without
the puppet wandering away emotionally

## the suspicious little suitcase format

Version 1 `.kokoro2d` files are UTF-8 JSON. Layer images are embedded as data
URLs, so one file contains the entire puppet instead of arriving with a folder
of seventeen textures named `final_FINAL_use_this_one_4.png`.

inside the suitcase:

```text
metadata + canvas settings
canonical parameter definitions
ordered image layers
grid meshes, UVs, and triangle indices
additive transform keyforms
per-vertex deformation keyforms
declarative physics settings
```

the schema and validator live in `src/model.js`. schema v1 is an **alpha**
format. it may change before stable release. if you build a multinational
puppet empire on an undocumented alpha schema this week, first of all iconic,
second of all PLEASE expect a migration script

## architecture, but make it emotionally available

```text
layered art
    ↓
Kokoro2D Maker ── mesh + keyforms + parameter bindings
    ↓
.kokoro2d puppet (one portable JSON goblin)
    ↓
Kokoro2D Viewer ── parameter blending + procedural performance
    ↓
WebGL2 ── textured triangles ── she moves!!! everybody remain calm
```

there are no runtime packages and no build step. browser modules load the
source directly. Node only visits for tests and static checks, drinks one water,
and leaves

## development (put on the serious glasses)

```bash
npm test
npm run check
```

`npm run check` validates every JavaScript module and runs the model tests. the
tests cover schema validation, serialization round trips, keyform interpolation,
additive channels, and malformed mesh rejection. the triangles are supervised

## things she cannot do YET

before anyone walks in holding a 900-layer PSD and the confidence of a person
who has never met a graphics pipeline, this alpha does not yet include:

- PSD import;
- clipping masks and blend modes;
- semantic hair/garment layer separation beyond the auto-rigger's feature lift;
- animation timelines;
- full deterministic physics authoring;
- webcam face tracking;
- Inochi model import; or
- Live2D `.moc3` loading. no. put it down

the next serious milestone is masking + blend modes, a versioned ZIP container,
deterministic physics, learned segmentation, browser integration tests, and
an adapter for the VTuber agency's performance intents. after that: assisted
rigging, better mouth forms, expression layers, and whatever else the puppet
union demands in writing

## license

the engine is MIT licensed. go forth. modify triangles. cause tasteful problems

the bundled Kokoro-chan sample is declared CC0 in its model metadata, which
means she is free to test with and has absolutely no excuse for missing stand-up

---

made with WebGL2, questionable ambition, and one drink that became a product
roadmap 💅
