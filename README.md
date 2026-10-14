# 💗 Kokoro2D

<p align="center">
  <strong>make the anime girl. bend the anime girl. give the anime girl microphone access. what could go wrong</strong><br>
  an original browser-native 2D VTuber maker + viewer, because apparently we own a rendering engine now
</p>

<p align="center">
  <img alt="WebGL2" src="https://img.shields.io/badge/WebGL2-summoned-ff69b4?style=flat">
  <img alt="Dependencies" src="https://img.shields.io/badge/core_browser_dependencies-zero-9f7aea?style=flat">
  <img alt="Schema" src="https://img.shields.io/badge/kokoro2d_schema-v3-f58bd4?style=flat">
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

the default puppet is now an actual original anime VTuber named Kokoro-chan,
complete with restrained portrait deformation, clipped pupils, deformable lashes and
mouth shapes, breathing, softly eased motion, and enough violet hair to
destabilize a modest graphics card emotionally

## 2026 tools have entered the chat

Paint-preserving eyelids now work on imported rigs, with independent winks,
squints, brow/jaw controls, and editable combined-pose corrections. The Maker
adds ownership brushes, layer retouching, OpenRaster import, isolated groups,
nested masks, and normal/multiply/screen/overlay blending.

The Viewer adds optional local webcam tracking, calibrated facial controls,
audio-clock viseme playback, expression hotkeys, a transparent OBS view, and a
local performance API. Project ZIPs store binary artwork; IndexedDB autosaves
keep recovery history. A visual benchmark includes 24 synthetic portraits and
two bundled artwork models, plus your own references.

Read the **[2026 tools guide](docs/2026-upgrade.md)** for workflows, schema v3
compatibility, streaming setup, timed-viseme formats, and checks. Webcam tracking
loads an optional MediaPipe model; learned hidden-art reconstruction requires a
separately configured local helper. Manual repair works without it.

## the body is no longer classified as an optional accessory

background removal now asks the border samples to agree before declaring a
colour disposable. previously, a shirt touching the bottom edge could be voted
“background” and the torso would leave the meeting. pale clothing gets a tighter
colour tolerance too. when the border is ambiguous, we keep the image intact
and tell you. uncertainty is allowed; unsolicited dismemberment is not

anime imports now try the optional local **anime landmark detector** first.
without it, the browser still compares eye candidates, looks for tiny line-art
mouths, and offers editable outlines. eyebrows remain capable of identity theft,
so please review the dots before handing them control of her face

For a simpler auto-rig, check **Blink and talking only** before choosing an image.
Review the face, eyes, and mouth, then build the rig. Only blinking and mouth
shapes are animated; the head, body, and hair stay still. Leave it unchecked
for the full rig.

The browser sample now has 18 layers: a portrait deformer, torso, a head deformer, face, bangs,
left/right hair, two eye openings, two movable irises, two eyelash ribbons,
two star overlays, a deformable mouth, the original closed lips, and a seam backing layer. A hair region that ends up with
almost no artwork — back hair, whenever the side regions meet across the middle
— is dropped along with its springs instead of shipping an empty texture, and
the report says so. **New sample** loads it; existing autosaves are preserved.

Kokoro-chan's reviewed rig preserves her painted eyes, highlights, and resting
smile. Gaze bends the eye interior with pinned corners; blinking lowers the
upper lid over the eyes without squashing their pupils or highlights. The lower
lid rises slightly, and the original painted lashes move with the upper lid
throughout the blink, ending on a curved seam. Normal blinks close completely;
occasional partial blinks still add variation. Skin sampled above
and below each eye covers the original drawing underneath. A sparse backing
layer retains small artwork details that automatic separation drops, including
the heart hair clip. Head turns add local face perspective, body bounce carries
the head and shoulders, and softer hair springs keep the seams calmer.
The earlier reviewed rig remains compatible with v2; new edits use v3. Choose **New sample** in the
Maker or **Bundled sample** in the Viewer to load it into an existing session.

- Eye openings clip the irises with WebGL stencil masks. The lashes bend without
  losing their thickness; pupil movement and blinking can run together.
- Portrait → torso and portrait → head → face/eyes/mouth/hair relationships are evaluated live.
  Editing a parent cage updates its children. The inspector supports parent,
  clipping layer, and deformer/mask-only settings. Cycles and invalid masks are
  rejected; detach dependents before deleting a parent or mask.
- Bangs and left/right/back hair have independent springs. Long strands have a
  second spring for the tips. Frequency is in Hz, damping is a damping ratio,
  and physics groups evaluate in array order so tip inputs follow their roots.
- Happy, Sad, Angry, and Confused are ordinary 0–1 channels, so they blend with
  each other and with everything else rather than replacing a pose. Each one
  bends the eyelash ribbons, reshapes the eye openings, moves the irises, and
  keys the mouth; sad droops the head and confused tilts it. Happy also fades in
  a star overlay clipped to each eye opening, so the sparkles ride the pupil,
  cannot escape the lid, and vanish when she blinks.
- Mouth Open, Mouth Form, and Mouth Rounded produce closed, wide, and rounded
  shapes, and there are now two ways to drive them. Microphone RMS drives
  openness while spectral balance estimates shape: a lightweight heuristic,
  **not phoneme recognition**, because audio alone cannot tell "ee" from "oo".
  Typing a line instead takes the other route and reads the spelling, which
  gives **real visemes** — see below.
- The torso carries chest springs in addition to sway and breathing. They are
  underdamped, so they overshoot and settle instead of tracking the body. The
  driver is breathing plus the rate of change of her weight shifts, and the
  deformation is a local lobe below the chin: it does not move the face.
- Torso amplitudes are measured against the subject, not the canvas, so the
  sway pivots at the base and carries the shoulders. At the amplitudes the
  idle performance actually reaches, sway moves about 14 screen pixels,
  breathing and the chest about 6, against 8 for head yaw and 13 for a blink.
- Idle drift is **pink noise**, not a sum of sines. Postural sway has a 1/f
  spectrum — a bounded correlated random walk — and a sum of sines is exactly
  what an eye catches as a loop. Measured over two minutes, the old idle scored
  0.87 autocorrelation at a 15-second lag; the drift that replaced it shows
  nothing beyond local smoothness.
- Movement follows **minimum-jerk submovements**, not exponential easing. The
  nervous system plans point-to-point motion by minimising jerk, which gives a
  bell-shaped velocity profile: slow start, fast middle, slow stop. A first-order
  lag is the opposite shape, fastest on its very first frame, and that is most of
  what makes eased motion read as robotic. Head movements in particular are
  composed of discrete submovements that rarely overlap, so that is how they are
  issued. Saccades are ballistic on the same curve, 30 ms for a flick and up to
  120 ms for a large jump, following the main sequence.
- Gaze is a behaviour, not a random walk. People in conversation look at their
  partner around 60 % of the time and avert for the rest; sampling directions
  uniformly gives a character who never quite meets your eye and never properly
  looks away either. She now alternates between looking at you and a definite
  aversion, landing at 60–62 % on you.
- Her mouth rests. The idle used to run a speech animation with no audio behind
  it, leaving her silently mouthing words 37 % of the time; it is now closed and
  relaxed with the occasional small movement, open about 3 % of the time, and a
  microphone still drives it exactly as before.
- The upper lid rides the eye downward, because the levator follows vertical
  gaze, and blinks vary in depth rather than every one being a full closure.
- Eyes and head are one system, not two. A small shift is made by the eyes
  alone; past a dead zone the head joins in, and because the head is far slower
  the eyes arrive first and then **counter-rotate in the orbit** as it catches
  up. That is the vestibulo-ocular reflex, and the combined gaze direction stays
  locked on the target throughout the handoff. It is most of what separates a
  puppet whose head and eyes move together from something that looks alive.
- The remaining timings come from the published human figures rather than from
  taste: blinking at 17/min calm and 27/min energetic (resting adults blink
  10–21 times a minute, conversation 10.5–32.5); a blink closing in 80 ms and
  reopening over 180 ms; breathing at 14.7 and 18.3 per minute against a resting
  12–20, on a waveform that is 40 % inhale and 60 % exhale rather than a sine;
  and one to two microsaccades a second, because a held fixation that is
  perfectly still reads as a freeze. A large gaze shift also carries a blink
  with it, since fixations end with a saccade or a blink and often both.
- Motion styles are named constant sets in `src/motion.js`. **Calm** is the
  original performance. **Energetic** — the Viewer default — turns about twice
  as fast, tilts into its glances, carries an always-on micro-bob, blinks
  roughly twice as often with occasional double blinks, and shifts its weight
  harder, which the chest springs answer with more overshoot. Switching styles
  mid-performance changes the constants only: the pose and springs carry over,
  so she speeds up rather than snapping. Adding a style is one literal.
- Maker and Viewer share fixed-step physics, eased motion, asymmetric blink
  timing, and smoothed microphone input. Pointer gaze persists until the pointer
  leaves or sits still for two seconds, after which she resumes looking around
  on her own: held glances, saccades, and periodic weight shifts, all without
  a mouse.

Every layer is cropped to its own artwork. The face, the hair and the torso used
to be full-canvas textures, which meant the face carried the same 12×16 mesh as
the entire picture while an eye carried its grid over a few hundred pixels — so
the eyes deformed finely and the face did not. The face layer is now 260×220
rather than 768×1152 on the bundled sample: the same drawing at roughly fifteen
times the mesh density, and 70% less texture memory across the rig. Deformation
cages are sized to span the layers they move, with a margin.

Auto-rigging now stops at a **placement review** before replacing the current rig.
Choose a face, eye, mouth, or hair region and **drag its outline points** to fit
the artwork. Drag inside to move the whole outline. Zoom up to 4×, double-click
an edge to add a point, or select a point and press Delete to remove it. Arrow
keys nudge a point (Shift moves five pixels). Outline Undo/Redo includes changes
to proportions; exact coordinates remain under **Position and size**.

The auto-rigger seeds eye and mouth outlines from nearby image edges, falling
back to a starter outline when there is too little contrast. **Fit to nearby
edges** retries within the selected feature's current bounds. It is a local
refinement, so correct a misplaced feature first. Face and hair outlines start
from the estimated regions and can be reshaped manually.

For a closed mouth, select **mouth → Source mouth is closed** and keep a thin
loop around the lip line. Closed-mouth mode automatically repairs crossed or
collapsed outlines, including zero-height ones, without a manual reset. The rig keeps
the original lips at rest and generates a taller opening for speech.

These outlines drive the actual cutouts, eye openings, lip shapes, and the
closure line between eye corners. They are saved in exported models. Older
rectangle-only rigs still load. Choose **Build layered rig** to continue;
closing the dialog cancels and keeps the current model.

Detection now isolates the head before measuring it. Exposed skin defeats the
old estimator two ways. When the neck is bare the face and body are one region,
so the estimator finds the neck as the first constriction the body widens out of
again and keeps only what is above it. When a choker or collar severs them they
are separate regions and the bare chest is simply the larger one, so skin
regions are ranked by where they start rather than by pixel count: a head is the
topmost skin in a portrait. Pale skin is also excluded
from background removal unless the background is itself skin-toned, because skin
sits about 42 units from white and used to be flooded away on white backgrounds.
Features are found by sliding a window the size of the expected feature and
taking the strongest response, rather than by taking a centroid over the whole
search band — a centroid drifts outward toward scattered dark pixels, which used
to push the eyes apart and the boxes with them. The eye search ignores dark
pixels with no skin beside them, so bangs stop dragging the eyes upward. The
mouth is then anchored on the eye pair rather than on the face box, because the
distance between the eyes is a stable fraction of an anime face while the skin
region runs past the jaw whenever a collar or a bare neck extends it. A mouth
must also be dark, red-dominant, and enclosed by skin above and below: blush is
red but bright, hair is dark but not red, and a lock of hair crossing a cheek
has skin either side of it but not above and below. Confidence is now scored on whether the result is plausible
rather than on how densely a blob fills its own bounding box, which used to rate
a whole-body "face" at 0.89.

**The confidence number is calibrated against measured accuracy.** Thirty
variants of the three bundled drawings — flipped, halved, padded, blurred,
darkened, desaturated, flattened, and dropped on a busy background — were scored
against ground truth that transforms with them. Two signals were missing. Blur
destroys the detail the feature search depends on while nothing else in the score
noticed, so a five-pixel blur held confidence at 0.73 for a result that had
fallen to 0.39; edge energy inside the face now answers for that. And the two
eyes should sit level, straddle the face centre and be a plausible distance
apart — when they disagree at least one is wrong, which is knowable without any
ground truth.

The face box is also recentred horizontally on the eye pair before the features
are placed. The skin centroid is a poor midline — hair across one cheek, or an
ear visible on one side only, shifts it while the eyes stay put — and every
feature band is positioned relative to that box, so a box that is 12 pixels off
puts both eyes and the mouth 12 pixels off with it. Only the horizontal centre:
reframing the box from the eye pair outright was measured and lost, because it
inherits whatever vertical bias the eye search has.

A third signal matters as much: **where in its search band a feature was found**.
A winner pressed against the edge of its band is suspicious, because the real
feature may lie outside it — most of the misplacements found while tuning this
were pinned to a corner — while one that settles in the middle had somewhere
else to go and stayed. A penalty applied to faces found without a visible neck
was also removed: measurement showed that path is not less accurate, and docking
it made every calibration figure worse. Confidence now tracks actual overlap at
**0.86** correlation (**0.90** by rank), lands within **0.10** of the real figure on
average, and across all thirty variants there is no longer a single case that
reads confident and is wrong.

Peak-to-sidelobe ratio, the textbook confidence for a response map, was measured
here and **scored worse** on every mapping tried: 0.77 correlation against 0.81.
These search bands are small, so their sidelobe statistics are unstable, and the
absolute response does carry signal — a real feature has mass and noise does not.

The skin region is trimmed to the chin whether or not a full neck constriction
was visible, since behind a collar the region still runs past the jaw and the
jaw narrowing is the part that matters.

Measured against the hand-reviewed regions in `src/sample.js`, mean overlap
across the two bundled renders went from 0.40 to 0.64, and the face rectangle
alone from 0.09 to 0.88 on the first and 0.89 on the second. `tests/browser_rig.py`
asserts floors for both so a regression fails the build. Two renders of one
character is a thin basis for tuning, so the estimator prefers rules that follow
from how anime faces are drawn over constants fitted to those images.

The face rectangle is anchored on the chin — the one landmark actually measured,
where the skin stops above the neck — rather than floated on the skin region's
centroid, and the width taper that trims the throat only runs when no neck was
found. A centroid-floated box lands short on a face whose jaw tapers, which took
the mouth outside the face entirely on a realistically drawn portrait.

**Proportions are a choice now.** Every facial ratio the estimator uses differs
by drawing style, and no single set serves both: an anime face has eyes about a
fifth of its height set close together with a small mouth just below them, while
a realistically drawn one has eyes a third that size, heavier brows, and a mouth
nearly twice as wide sitting nearly twice as far down. The placement review has
an **Anime / Realistic** selector that re-estimates every outline from the same
artwork, so you can see which fits and switch. Measured against hand-marked
truth, a flat realistic portrait scores 0.93 face and 0.73/0.86 eyes on
Realistic, against a face box that stopped at the nose on Anime.

**Optional: let a local model pick the preset.** If [Ollama](https://ollama.com)
is running with a vision model, the review offers a **Detect with Ollama**
button. The artwork is posted to `localhost` and goes nowhere else; if Ollama is
not running the button never appears and nothing else changes. No dependency was
added — it is one `fetch`.

It is used for the preset and nothing more, because that is the only part it
does better than the geometry. Measured against hand-marked truth on three
drawings, `qwen3.5:9b` located facial features at **0.45** mean IoU against
**0.61** for the heuristics — even given a magnified crop of a face the
heuristics had already found. It picked the right preset on all three, three
runs each, but only when asked to compare eye height to head height; asked to
name an art style it calls a flatly shaded realistic illustration "anime", which
it is. A general vision model grounds semantics well and regresses coordinates badly.

A dedicated landmark model is not obviously the answer either, which is worth
recording since it sounds like it should be. MediaPipe Face Landmarker **detects
no face at all** on the anime artwork; where it does detect, it traces a human
eye opening rather than the drawn one, scoring 0.36 and 0.61 mean IoU against
0.65 and 0.78 for the geometry here. It is trained on photographs, and a drawn
eye is not a photographed one.

Two things still resist the heuristics on flat realistic art: eye white is not
reliably brighter than skin in pale shading, so the sclera cannot separate an
eye from an eyebrow, and a line-art mouth has almost no coloured mass to find.

Moving layers are feathered into what sits beneath them. A hard alpha edge
stamps a cut-out onto the picture and every separation boundary traces a visible
contour — most obviously along the jaw, where the face ellipse ends. Because the
torso underneath now carries a diffused fill of the area the face covers, a
softened silhouette blends into something close to the right colour instead. The
torso itself keeps its hard outline, since it is the base against the background.

Bangs take hair and never skin. Allowing them to claim warm pixels above the
face box cut the forehead along a dead straight horizontal line at exactly that
boundary, which is not where anyone's hairline is.

The seam fill diffuses rather than streaks. It used to reach into the area a
moving layer had vacated by copying the nearest opaque pixel outward, which
drags one colour along a line: a dark eyebrow or a hairline smeared upward as a
streaky ghost of itself, invisible while the head faced forward and obvious the
moment it turned. Averaging the already-filled neighbours spreads it smoothly.
A hair region must also hold a real mass of hair, judged against the character
and against the largest hair region — not against the canvas, which sets the bar
far too low for a portrait on a large empty background. On a tied-back hairstyle
the side regions catch a handful of stray strands, and a layer holding only
those swings around on its springs like confetti on a string.

All of this lives in `buildLayeredRig`, which is the one function behind the
bundled sample, **✨ Auto-rig PNG**, and every `.kokoro2d` either produces. There
is no separate path: rig anything and it arrives with the same blending. Files
exported before a change keep whatever they were built with — rebuild to pick it
up.

Single-image separation remains approximate. The current hair colour heuristic
works best with purple/pink or dark hair; outlines and a protected torso region
limit accidental clothing extraction. Small exposed seams use nearby pixels,
while eye and mouth backgrounds are reconstructed from nearby skin colours.
It does not recover hidden artwork, accurately separate arbitrary hairstyles,
or preserve every original lash detail. Large turns can still expose seams.
For higher fidelity, import artist-separated layers and use the same parent and
clipping controls. A clipping mask must itself be unmasked; nested masks and
blend modes are not supported yet. Parent visibility/opacity does not hide its
children, allowing invisible deformation cages.

New rigs use schema v2 to store parent bindings and clipping references. The
reader still accepts v1 files; editing an older rig saves it as v2. Older v1-only
viewers cannot load v2 exports. The browser renderer remains dependency-free.

Rigging references: [material separation](https://docs.live2d.com/en/cubism-editor-manual/divide-the-material/),
[eyes and clipping](https://docs.live2d.com/en/cubism-editor-tutorials/expression/),
[parent deformers](https://docs.live2d.com/en/cubism-editor-manual/system-of-parent-child-relation/),
[multi-stage hair physics](https://docs.live2d.com/en/cubism-editor-manual/physical-operation-setting/),
and [speech shapes](https://docs.live2d.com/en/cubism-editor-manual/motion-sync/).

## NEW: hand her one PNG and walk away dramatically

the Maker now contains a **Full Auto Rigger**. click `✨ Auto-rig PNG`, give it
one front-facing anime portrait, and the Maker will attempt the following locally.
the optional detector receives the image through your localhost server; no
mysterious cloud bucket named `definitely-not-your-waifu` receives the artwork:

- remove a flat or transparent background;
- find the character silhouette;
- find the face, eyes, and mouth with the optional anime landmark model;
- fall back to browser image heuristics when the model is unavailable;
- split a portrait into approximate face, torso, and hair layers;
- reconstruct eye openings, movable irises, lashes, and mouth shapes;
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
> browser dependencies: NONE. optional Python detector: she brought luggage<br>
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
command is `npm start`. we can do this together

## what even is this

Kokoro2D currently proves that one understandable, dependency-free codebase can
handle:

- layered character artwork;
- deformable textured meshes;
- parameter keyforms and interpolation;
- procedural head, body, eye, mouth, blink, hair, and chest performance;
- blendable facial expressions, including stars in her eyes;
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

**The Viewer opens on whatever you have in the Maker.** It reads the Maker's
autosave, so the puppet you just rigged is the one you see — previously it always
opened on the bundled sample, which meant your own work was the one thing you
could not look at. Leave both tabs open and the Viewer follows the Maker as you
work. **Bundled sample** goes back to Kokoro-chan, and loading a `.kokoro2d`
stops the syncing so an opened file is never yanked out from under you.


the standalone Viewer includes:

- WebGL2 textured triangle rendering;
- additive parameter and keyform evaluation;
- procedural idle performance that needs no input at all;
- springy secondary hair and chest motion;
- one-click expressions that blend into the running performance;
- switchable motion styles, calm through energetic;
- pointer-directed gaze (she knows where you are), released when you stop moving;
- optional microphone lip sync, plus viseme lip sync from typed text;
- transparent canvas output for future OBS integration; and
- loading models exported by the Maker, which sounds obvious until you have
  written a file format at 1:17 in the morning.

touching a parameter slider pauses the demo so you can inspect a pose without
the puppet wandering away emotionally

## the suspicious little suitcase format

Version 2 `.kokoro2d` files are UTF-8 JSON. Layer images are embedded as data
URLs, so one file contains the entire puppet instead of arriving with a folder
of seventeen textures named `final_FINAL_use_this_one_4.png`.

inside the suitcase:

```text
metadata + canvas settings
canonical parameter definitions
ordered image layers + parent bindings + clipping references
grid meshes, UVs, and triangle indices
additive transform keyforms
per-vertex deformation keyforms
declarative physics settings
```

the schema and validator live in `src/model.js`. schema v2 is an **alpha**
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

there are no browser runtime packages and no build step. browser modules load
the source directly. Node only visits for tests and static checks, drinks one
water, and leaves. the optional anime detector brings Python, PyTorch, and
model weights to the local server. yes, the dependency cupboard has an annex now

## her head has agreed to accompany her face

previously, the face could turn while blonde hair and fox ears stayed behind in
the torso layer. apparently the skull had outsourced attendance. new full rigs
use a shared **Portrait Deformer**: face, hair, ears, and torso all inherit the
same movement, including artwork the separator could not identify as hair

turns and tilts carry the head, ease through the neck and shoulders, and leave
the base planted during body sway. separated hair still gets its own secondary
springs. the whole creature participates. a modest organisational breakthrough

**Re-import the original image to rebuild an older rig.** Leave **Blink and
talking only** unchecked if you want head and body motion. that checkbox means
what it says, despite everything else about this repository. large turns can
still stretch a single drawing; we have not discovered the back of her head

## she can read now, which means her mouth finally agrees with the vowels

the microphone path is a guess and always was. loudness tells you *that* she is
talking, spectral tilt tells you roughly how bright the sound is, and neither of
them can tell "ee" from "oo" — so the mouth mostly opened and closed on vibes 🙃

`src/viseme-lipsync.js` goes the other way round. type a line, and it reads the
spelling, converts it to Oculus-style viseme ids with a compact English rule
set, and lays those over the words. same `{open, round, form}` triplet out, so
it lands exactly where the microphone shape lands in `motion.update()`:

```
"hello"  ->  E  nn  O
"you"    ->  I  O   U
"though" ->  TH O          (longest match wins: OUGH, not OU + GH)
"make"   ->  PP aa  kk     (the final E is silent past four letters)
```

the rules are a rule set and not a dictionary, on purpose: nothing to ship, and
invented words and names still get a mouth. it will mispronounce the genuinely
irregular ones — "colonel" is a lost cause, and "are" keeps an E it should not —
which costs one wrong shape for one syllable and nothing else.

Word durations start as estimates from spelling and punctuation. When the
browser emits speech word boundaries, the mouth and gesture clock realign to
each word. Browsers without those events use the estimated track; the speaking
rate is measured after each completed line and remembered in `localStorage`.
A caller with complete word timings can pass `buildVisemeTrack(text, { timings })`.
P/b/m close the lips fully, and ending or stopping speech releases its track
even if its estimated duration was longer than the actual voice.

The Viewer also borrows a performance idea from `heads`: speech moves more
than the mouth. Long words get spaced nods, questions get a small tilt, and
negations get a brief shake. Long phrases glance aside and return toward the
viewer at their end, with phrase-end blinks. These are cues inferred from text,
not measured pitch or stress. Pointer gaze takes priority, and expressions
remain under your control. Toggle **Speech gestures** to compare, or adjust
their strength in the motion tuner. Ctrl/⌘ + Enter speaks the current line.
Browser speech audio plays outside the page and is not included in WebM
recordings; an enabled microphone supplies recording audio.

`motion.update()` now takes `mouth` as the general external mouth drive;
`microphone` still works and means the same thing, so nothing that predates
this has to change. note that Mouth Rounded is an optional parameter: a model
has to declare it before the rounding component reaches the rig, which the anime
mouth does.

every export is pure and importable under Node, so the rules are unit-tested
without a browser in `tests/viseme-lipsync.test.js`, down to whether a track
actually moves `mouth.open` once it has been through `motion.update()`.

## the mouth has escaped its career as a stretchy punctuation mark

new anime rigs open a smooth cavity from the reviewed lip line. the lower jaw
moves farther than the upper lip, quiet syllables stay small, and wide versus
rounded shapes change both width and height. sparse lip landmarks become curves
instead of a tiny angry chevron. she has vowels now. approximately. do not send
her to a linguistics conference unsupervised

her original closed smile stays at rest. skin under the moving mouth is rebuilt
from nearby pixels so the old smile does not haunt every “oo”. speech closes
more promptly between phrases, because finishing a sentence with your mouth
still buffering is a very particular lifestyle

**Re-import the original artwork to get the new mouth geometry.** Check the
mouth outline and **Source mouth is closed** before building. exported models
keep the shapes they were built with; refreshing cannot retroactively educate
a JSON file

microphone input estimates openness and shape from loudness and spectrum.
**this is not phoneme recognition.** it cannot reliably distinguish your “ah”
from your existential screaming. both have excellent energy

## anime landmarks: we hired someone who knows where the eyes are

**Auto-rig PNG** now tries [hysts/anime-face-detector](https://github.com/hysts/anime-face-detector)
for anime images. its 28 landmarks become editable face, eye, and mouth outlines
in both full-rig and **Blink and talking only** modes. it measures the central
lip gap, so a curved closed smile does not accidentally file paperwork as an
open mouth. the result card says **Anime landmarks** when applied

this is an **optional local Python model**. the browser renderer still needs no
packages. run through `npm start`, and restart the server after installing or
changing detector configuration. the server checks `.venv-anime`, its own
Python, then the base environment of `conda` on PATH. one of these Pythons must
actually contain the detector. a snake collection alone is insufficient

already have a working environment? point at its Python:

```bash
KOKORO_ANIME_PYTHON=/path/to/environment/bin/python npm start
```

fresh setup? use Python 3.12 or newer; this example uses 3.13:

```bash
python3.13 -m venv .venv-anime
.venv-anime/bin/python -m pip install anime-face-detector==0.1.0
npm start
```

the first detection may download model weights. **your artwork stays on your
machine.** CPU inference loads the model for each request, so give it several
seconds to locate the anime. one inference runs at a time; there is one little
reception desk and she is doing her best

**Detect anime landmarks** retries from placement review. Undo restores your
previous outlines. missing dependencies, failed detection, and weak feature
scores fall back to estimated outlines with a warning. multiple faces select
the largest, so inspect the result before accidentally rigging the background
character who has three lines and an unusually compelling character arc

landmarks locate facial features. they do **not** separate hair or recover
hidden artwork. blonde hair boundaries still need review. the bundled sample
keeps its hand-reviewed regions and does not summon the model at startup

checks for the freshly employed eye specialist:

```bash
python3 -m unittest discover -s tests -p 'test_anime_server.py'
python3 tests/browser_anime.py /path/to/portrait.png
```

the first tests the endpoint without model dependencies. the second needs
Playwright and the detector, starts its own test server, and checks outlines,
Undo, export, both rig modes, and fallback when the detector leaves the building.
it also saves mouth and head-pose previews in `/private/tmp` for visual review

## development (put on the serious glasses)

```bash
npm test
npm run check
```

`npm run check` validates every JavaScript module and runs the Node tests,
including hierarchy composition, editing coordinates, schema compatibility,
clipping references, speech estimates, frame-rate consistency, and spring chains.

With Playwright installed and `npm start` running, use
`python3 tests/browser_rig.py` for browser integration checks: actual mask pixels,
combined expression screenshots, portable export/import, persistent gaze,
placement validation, and cancellation. Screenshots are saved in `/private/tmp`.
Use `python3 tests/browser_speech.py` for speech timing, lip closure, keyboard
submission, and cancellation checks. It mocks OS speech events and checks the
real Viewer controls and rendering; it does not verify audible voice output.

## things she cannot do YET

before anyone walks in holding a 900-layer PSD and the confidence of a person
who has never met a graphics pipeline, this alpha does not yet include:

- PSD import;
- learned semantic hair/garment segmentation;
- animation timelines;
- a dedicated physics authoring panel;
- Inochi model import; or
- Live2D `.moc3` loading. no. put it down

the remaining research work is learned semantic segmentation and reliable
automatic completion of hidden artwork. the local reconstruction adapter can
connect an external helper, while brushes and artist-painted layers remain
available. the puppet union still wants more real-world reference drawings

## license

the code and documentation use the [MIT license](LICENSE). go forth. modify
triangles. cause tasteful problems

the bundled Kokoro-chan artwork and sample models use
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). you can share, remix,
and use them commercially; credit Kokoro2D contributors, link the license, and
say what you changed. the puppet gets credit even when she misses stand-up

[ASSETS.md](ASSETS.md) lists the covered assets and a copyable credit line;
[LICENSE-ARTWORK.txt](LICENSE-ARTWORK.txt) contains the full artwork license.
these licenses do not change the ownership or license of artwork you import.

---

made with WebGL2, questionable ambition, and one drink that became a product
roadmap 💅

### Interviewer portrait

`interviewer.kokoro2d` refines the supplied `sample.kokoro2d` with gentle head
turns and nods, breathing, posture shifts, eye gaze, and smaller speech shapes.
The original embedded artwork is preserved. Its saved calm motion profile keeps
the mouth closed at rest. Recreate it with `node scripts/create-interviewer.mjs`.

In the Viewer, use **Load .kokoro2d** or drop a file onto the stage. Loaded models
start playing automatically. **Preview talking (no audio)** demonstrates mouth
movement without microphone access; microphone lip sync takes priority when on.

### Engine lifecycle (Project Heartbeat)

The renderer now replaces models transactionally and rebuilds its GPU resources
following WebGL context loss. The current pose and framing survive recovery.
An interrupted recording is cancelled with a status message; microphone lip-sync
remains available. In Viewer, enable or disable the microphone explicitly and
choose an input after granting permission. Switching inputs and leaving the page
release the microphone's audio graph and tracks.

See [Project Heartbeat Phase 1](docs/project-heartbeat.md) for the inspected
baseline, prioritized follow-up work, resource ownership and verification.
