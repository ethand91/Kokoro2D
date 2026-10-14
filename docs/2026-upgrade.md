# 2026 avatar tools

The Maker and Viewer still run with `npm start`, without a build step. Webcam
tracking is optional and loads MediaPipe only when enabled. All other editor,
renderer, archive, audio-timing, and benchmark features use browser APIs.

## Facial rigging

New imports preserve the full painted eye and extract a moving lash ribbon.
In placement review, **left/right Eye** outlines describe the source paint to
remove; **left/right Lid** outlines describe the visible aperture inside the
lashes. Review both before building. Untick **Preserve painted eyes and lashes**
to use the procedural eye reconstruction instead.

Generated rigs expose shared Blink, Left/Right Blink, Squint, Brow Raise, Jaw,
and Mouth Corners. Shared blink and each eye's closure combine by maximum, so
simultaneous drivers do not close the lid twice. Brow and jaw controls deform
the face artwork locally. These channels are authored on full rigs; the
blink-and-talking preset keeps the head, body, and hair still.

For a correction that only applies when two parameters move together:

1. Select a layer and enable **Combined-pose correction**.
2. Set both channels away from their defaults.
3. Create a keyform and sculpt the mesh or transform.
4. Preview either channel returning to neutral. The correction fades out on
   either neutral axis. Ordinary single-channel keyforms still contribute.

Corrections store residual offsets, weighted by the product of each driver's
smoothstep distance from neutral to the authored target. Different signed
corners can have different corrections.

## Artwork preparation

Ownership brushes in placement review let you claim or exclude pixels for the
face, bangs, left/right hair, or back hair. They override colour heuristics,
which helps with blond hair or similarly coloured clothing. Clear removes the
brush override. Undo restores the previous ownership mask.

**Retouch / replace artwork** opens a separate editor for the selected layer.
Paint, erase, undo strokes, or replace the image. Apply commits one undoable
edit; Cancel keeps the original. To create backing artwork, import a separate
PNG, place it behind the moving part, and bind it to the same parent deformer.

**Open** accepts OpenRaster `.ora` files. The importer preserves layer names,
positions, visibility, opacity, isolated groups, and normal/multiply/screen/
overlay blending. Pass-through groups and unsupported blending operations are
reported explicitly; convert them to supported isolated groups in your paint
application first. PSD import is not included.

### Optional reconstruction helper

A local reconstruction process can fill areas marked with the retouch editor's
**Repair mask**. Configure it before starting the server:

```sh
KOKORO_RECONSTRUCT_COMMAND='python3 /path/to/your_local_repair.py' npm start
```

The command receives one JSON object on stdin with `image` and `mask`, both PNG
data URLs. Opaque mask pixels mark the area to reconstruct. It must write one
JSON object to stdout, `{"image":"data:image/png;base64,..."}`, preserving image
dimensions. Diagnostic logs belong on stderr. The server invokes the configured
command without a shell, serializes inference requests, and limits execution
to 180 seconds. Artwork is sent only to the local server; configure a genuinely
local helper to keep that property.

No learned reconstruction weights are bundled. The February 2026
[See-through paper](https://arxiv.org/abs/2602.03749) motivates the layer-completion
workflow, but this project does not claim to implement or reproduce that model.
Manual retouching and imported artist-painted layers work without the helper.

## Webcam performance

In the Viewer, enable the webcam and then **Calibrate neutral face** with eyes
open and a relaxed mouth. Sensitivity scales head movement; Smoothing reduces
jitter. Tracking runs in a worker, with only one frame in flight. Missing
tracking fades back to the idle performance. Stop webcam releases the camera
and worker. Audio-driven mouth shapes take precedence over tracked mouth
movement while speech is active.

The optional dependency is MediaPipe Tasks Vision **0.10.32**, with Google's
Face Landmarker float16 model version **1**. The default downloads come from
jsDelivr and Google storage. Frames are processed locally and are not uploaded.
To self-host/offline-cache it, place the matching bundle, WASM files, and model
at:

```text
static/mediapipe/vision_bundle.mjs
static/mediapipe/wasm/...
static/mediapipe/face_landmarker.task
```

Keep the JS and WASM versions matched. A denied camera permission or failed
model download leaves the regular Viewer available.

## Timed audio and mouth shapes

Open **Audio with timed mouth shapes**, choose an audio file, and load a JSON
track. Use the audio controls to play, pause, seek, or change speed; mouth shapes
sample the audio element's actual playback position. The canonical format uses
milliseconds:

```json
{
  "segments": [
    {"viseme":"PP", "t0":0, "t1":80},
    {"viseme":"aa", "t0":80, "t1":450},
    {"viseme":"U", "t0":450, "t1":800},
    {"viseme":"sil", "t0":800, "t1":1000}
  ]
}
```

Supported names: `sil`, `PP`, `FF`, `TH`, `DD`, `kk`, `CH`, `SS`, `nn`, `RR`,
`aa`, `E`, `I`, `O`, `U`. Tracks must be ordered, non-overlapping, and no longer
than an hour. Gaps are silence. Rhubarb's `mouthCues` format is also accepted;
its times are seconds. Export provider/aligner timings into either format.

The app does not run an acoustic phoneme recognizer. Microphone analysis and
typed-text speech remain available. Timed playback is included in a recording
when playing at recording start; otherwise microphone audio is used if active.
Browser speech-synthesis audio is still outside the recorder's capture path.

## Streaming and local control

Set framing in **Streaming and framing**. For OBS, export a `.kokoro2d.zip`
project into the server directory and enter its path, such as
`/performer.kokoro2d.zip`. Copy the transparent Viewer URL into an OBS Browser
Source. Example:

```text
http://127.0.0.1:5173/viewer.html?stream=1&model=/performer.kokoro2d.zip&zoom=.78&x=0&y=0
```

Streaming mode hides the interface and keeps the page transparent. OBS uses a
separate browser profile, so a model path is required to use your exported
puppet rather than its bundled sample. Paths must be served from the same
origin. Keep the local server running.

Hotkeys 1–4 toggle expressions; 0 clears them. Typing in a text field does not
trigger hotkeys. Enable **Send performance to local streaming viewers** in the
normal Viewer to drive OBS from that window's webcam, speech, or controls.
Streaming viewers listen automatically; other Viewer windows receive commands
only when **Receive local API controls** is enabled.

Send a local performance intent with JSON:

```sh
curl http://127.0.0.1:5173/api/control \
  -H 'Content-Type: application/json' \
  -d '{"type":"parameters","values":{"head.yaw":0.4,"eyes.blinkLeft":1},"holdMs":500}'
```

Other commands:

```json
{"type":"expression","id":"expr.happy"}
{"type":"expression","id":null}
{"type":"speech","text":"Hello from the local controller."}
{"type":"visemes","track":{"segments":[{"viseme":"aa","t0":0,"t1":500}]}}
{"type":"reset"}
```

Speech uses the Viewer's existing browser voice and may require an initial
user interaction for browser audio permission. The visemes command supplies a
track for the already loaded audio; it does not upload or start an audio file.
Parameter commands clamp declared channels and ignore unknown channels. Holds
last 50–15,000 ms, then normal performance resumes. Events are ordered, retained
for 15 seconds, and available through `GET /api/control?after=<sequence>`.
The built-in server binds to loopback and rejects cross-origin control posts.
It is intended for trusted local tools, not an internet-facing service.

## Compositing and project storage

The layer inspector supports normal, multiply, screen, and overlay. Isolated
groups have independent visibility, opacity, blending, masks, and parent groups.
Group fading is applied after its children are composited, preserving opacity
where children overlap. Compositing groups are independent of deformation
parents; an invisible cage can still deform visible children. Nested clip masks
intersect, and cyclic references are rejected.

New models use schema **v3**; v1 and v2 JSON models still load. New fields are
`groups`, layer `group`, `blendMode`, `eyeSide`, and `correctives`. Older apps
cannot interpret these new features. **Export .kokoro2d** keeps the JSON option;
**Export project ZIP** creates `.kokoro2d.zip`, containing a versioned
`manifest.json` and deduplicated binary artwork. A ZIP's container version is
independent of its model schema version. Import supports stored and DEFLATE
entries, checks CRCs, and bounds expanded size to 256 MiB.

Autosaves use IndexedDB with ten retained revisions and shared artwork assets.
**Recovery history** restores a saved revision. Existing localStorage model
saves migrate when opened; localStorage then carries only a small change marker
for Maker/Viewer synchronization. Undo also interns artwork instead of copying
base64 images into every history frame. Export a project for a portable backup;
browser storage remains tied to this browser profile and site origin.

## Visual benchmark and checks

Open `/benchmark.html` to compare the two bundled artwork models and 24
synthetic reference portraits. Select a pose, animate combined turns/blinks,
save pose PNGs, add reference drawings/projects, or run every pose on every
character and download JSON measurements. The synthetic fixtures have known
feature regions; automatic eye localization is scored separately from rigs
built using those reviewed annotations.

The report records finite/reversible geometry, CPU frame p95, texture memory,
and eye-region IoU. It does not claim perceptual quality from geometry alone.
Inspect pupil stability, lash continuity, seams, and mouth closure. Renderer
measurements exclude asynchronous GPU execution. Viewer diagnostics report
rolling CPU frame p95 and estimated texture/surface memory; unchanged vertex
buffers and shared source textures are reused.

The bundled corpus contains **24 synthetic illustrations plus two existing
artwork models**, not 26 independently drawn artist references. Add real-world
licensed reference artwork to assess generalization beyond these fixtures.

```sh
npm run check
python3 -m unittest discover -s tests -p 'test_*server.py'
python3 tests/browser_roadmap.py
python3 tests/browser_sample.py
python3 tests/browser_rig.py
python3 tests/browser_speech.py
python3 tests/browser_record.py
```

Browser checks require Playwright/Chromium and a running server. Set
`KOKORO_TEST_URL=http://127.0.0.1:5174` to test another local server.
