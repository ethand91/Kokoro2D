# Project Heartbeat Phase 1.1: Production hardening

Branch: `feature/project-heartbeat-phase1`. Audit date: 2026-10-14.

The baseline was commit `83c45de`, with pre-existing local changes to
`package.json` and untracked `AGENTS.md`, `benchmark.html`, and `sample.png`.
Those changes are preserved and excluded from the hardening commit. No runtime
packages, model-schema changes, artwork changes, or rendering architecture
replacement were introduced. Model versions 1, 2, and 3 remain supported.

## Baseline and confirmed fixes

Baseline `npm run check` ran on Node 20.18.0: 134/135 tests passed. The one
failure was a hierarchy test that called an invalid one-byte PNG a valid model;
the fixture now uses a real PNG. Python 3.10.9 server checks passed 8/8.

| Confirmed problem | Change and regression coverage |
| --- | --- |
| Tracking stopped during worker initialization left startup awaiting its 60-second timeout | Session-owned cancellation settles startup immediately; stop clears initialization timer and worker callbacks |
| Late playback/frame operations could report obsolete errors, and stop retained video references | Session identity guards every continuation and callback; late grants stop their tracks, untransferred bitmaps close, video detaches, errors from obsolete sessions are ignored |
| Viewer disabled the webcam button during startup and kept the previous tracking pose after stop | Startup offers cancellation; UI request guards prevent stale completion; null poses release tracking immediately |
| Control outages polled every 80 ms; multiple starts could create multiple loops | One loop per session, abortable fetch/body reads and waits; bounded exponential backoff with jitter, success resets to the normal 80 ms interval |
| Control batches trusted response size, sequence shape, command values and inherited definition properties | Stream/JSON budgets, complete batch validation before cursor mutation, own-property parameter lookup, finite ranges/values, size limits, exception isolation |
| Origin comparison alone permitted attacker-controlled hosts/DNS rebinding | Loopback Host validation, exact Origin and Fetch Metadata checks, remote-bind bearer authentication and configured Host; private paths, symlink escapes and directory listings blocked |
| IndexedDB accepted invalid saves; exceptions while queuing requests could leave earlier writes committed | Validate captured models before queuing; abort the whole transaction on synchronous failures, including failure after writing `current` |
| Recovery read revision and assets in separate transactions; legacy fallback was not consistently validated | Read referenced assets in the same transaction, verify SHA-256 identifiers, validate restored models and legacy data; migrate legacy data without deleting it on failure |
| Regex asset substitution could also rewrite metadata resembling an asset reference; failed opens prevented retries | Structural source-reference rewriting; retry failed/closed database connections; bound save queue and hash-cache memory |
| Maker deleted legacy recovery state and saved the sample over `current` after a failed restore; save errors could be overwritten by a success message | Startup fallback skips autosave, preserves stored work and reports recovery failure; failed-save status remains visible; Viewer reports recovery failure too |
| A recording compositor exception escaped the animation loop | Failed take discards capture resources and reports error; subsequent recording works, borrowed audio remains live |
| Frame upload GL errors could be silently treated as a committed vertex cache | Frame GL error check reports failure; invalidate vertex caches for retry; existing GPU allocation rollback and recovery behavior retained |

Worker frame processing already closes transferred images in `finally`.
Terminating its owning worker handles cancellation during model download or
inference. Worker code was inspected and did not need a protocol change.
Existing texture decoding already bounds bytes/pixels, detaches handlers and
revokes URLs on cancellation; archive import validates the manifest and final
model. Those implementations were retained and exercised through existing and
new tests.

## Lifecycle and compatibility contracts

- `FaceTracker.start()` resolves `true` when active and `false` when cancelled;
  genuine current-session startup errors reject. Existing callback arguments,
  calibration, sensitivity and blink smoothing remain. `stop()` and `dispose()`
  are idempotent. A browser permission prompt itself cannot be dismissed by the
  application; a later grant is released immediately.
- `ControlInbox.start()` returns the existing loop promise when already running;
  stop aborts the request/body read and wakes a pending retry wait. Restart is
  supported. Failures wait 125–250 ms initially, rising to 1–2 seconds; requests
  time out after 5 seconds. A reachable server is retried within 2 seconds after
  a failed attempt completes. Server restarts reset the cursor. Invalid batches
  never update it. Command handler/diagnostic errors cannot wedge later events.
- Control commands are at most **16 KiB UTF-8 JSON**, with at most 128 parameter
  entries, 4000 speech characters and 512 canonical/Rhubarb viseme segments.
  Viseme times must be finite, ordered and non-overlapping, at most one hour.
  Batches contain at most 256 events and response bodies at most 5 MiB. Healthy
  local polling remains 80 ms. Out-of-range finite parameters clamp to declared
  min/max; unknown parameters are ignored; unknown expressions are rejected.
  Expression commands also respect declared ranges. Hold durations clamp to
  50–15000 ms. The public `parameterCommand` helper retains per-value rejection
  for callers supplying mixed finite/nonfinite values; transport commands reject
  nonfinite values as a whole.
- Storage retains ten backup revisions plus `current`, deduplicates artwork by
  SHA-256, bounds pending saves to 32 and its source hash cache to 32 MiB/512
  entries. A queue-full error explicitly requests retry/export. Corrupt recovery
  entries and missing/tampered assets are rejected before activation. Failed
  writes preserve the previous committed transaction; later writes retry.
  If a retained revision cannot be parsed, artwork collection is deferred rather
  than guessing which artwork is safe to delete. Legacy migration failures return
  the validated legacy model with a recovery warning and retain localStorage.

## External-agent trust boundary

`npm start` still binds **127.0.0.1**. Browser controls remain opt-in in the normal
Viewer; streaming mode keeps its existing automatic listener. There is no CORS
allow-all authorization. Requests with an Origin must match the validated Host
exactly; null/foreign origins and cross-site/same-site Fetch Metadata are denied.
Requests without Origin remain available to local command-line agents.

Loopback is a trust boundary for processes on this machine, not isolation between
local agents. Any local process can enqueue allowed controls. It cannot use this
API to choose filesystem paths, evaluate JavaScript or launch arbitrary commands.
The server does not know the active model's definitions: the Viewer exclusively
applies declared parameters and clamps their values. A hostile local process
that can modify the repository or server environment is already outside this
boundary.

If a handler is deliberately hosted on a non-loopback listener, **all** requests
require both `KOKORO_ALLOWED_HOST` (exact Host, including port if present) and
`Authorization: Bearer <KOKORO_CONTROL_TOKEN>`. Missing configuration/token fails
closed. The default CLI does not expose a remote-bind option. Remote browser
login/token provisioning and TLS termination are not provided: a deployment must
supply authenticated HTTPS/proxy infrastructure, retain Host/Origin validation,
and protect any proxy forwarding to the trusted loopback listener. CORS alone
is insufficient. Tokens should not be placed in URLs.

The optional image-repair adapter continues to execute only the operator's
`KOKORO_RECONSTRUCT_COMMAND` without a shell, with only validated image/mask input.
Payloads cannot choose its command or arguments. Only configure trusted helpers;
the adapter is not a sandbox for arbitrary third-party repair code. Authenticated
agents can still flood allowed requests; public deployments need rate limiting.

## Executed verification

Final checks on this checkout:

| Check | Actual result |
| --- | --- |
| `npm run check` | Passed: syntax checks and 164 Node tests |
| `python3 -m unittest discover -s tests -p 'test_*server.py'` | Passed: 12 tests |
| `tests/browser_hardening.py`, Chromium 143 and Firefox 144 | Passed in both: valid/malformed import, 30 switches, real WebGL loss/recovery, actual recording export, command validation/auth rejection, bounded expression values, startup cancellation, 10 tracking cycles, IndexedDB quota/partial-write/abort/retry, ordered saves, retained artwork/GC, corrupt/missing assets and revisions, migration failures, startup recovery failures, visible save errors, browser-process restart |
| `tests/browser_lifecycle.py`, Chromium and Firefox | Passed in both: Maker/Viewer graphics recovery, identical fixture pixels, v1/v2, microphone switching/disable/pagehide, recording interruption and subsequent take |
| `tests/browser_roadmap.py`, Chromium | Passed: project/archive/recovery, artist controls, timed audio, local API, streaming, blend/group/mask GPU pixels, OpenRaster |
| `tests/browser_rig.py`, Chromium | Passed: export/import, gaze, placement and cancellation; no page errors |
| `tests/browser_record.py`, Chromium | Passed: 940×836 VP9, microphone audio, backdrop, fixed size across mid-take resize; ffmpeg/ffprobe inspected output |
| Python compile checks and `git diff --check` | Passed |
| GitHub Actions push/PR runs | Blocked before executing any steps: account payment/spending-limit failure; no hosted test results |

Playwright 1.57.0 was used locally. Camera/worker behavior in the new UI checks is
mocked to avoid permission UI, hardware and MediaPipe downloads; controller tests
cover pending playback/initialization, timeout/denial, late callbacks/bitmaps and
worker failures. Microphone checks use browser-generated inputs. IndexedDB
checks use the real browser implementation; quota faults inject
`QuotaExceededError` into its request methods, and abort tests abort real
transactions. They do not claim to exhaust physical disk storage.

Early harness runs exposed an overly narrow error-message assertion and fixed
sleep races in `browser_rig.py`. The corrected runs passed; no failed attempt is
reported as a pass. Firefox was initially absent, then installed and actually run.

## Diagnostics and repeatable performance

Viewer DevTools: `window.kokoroDiagnostics()` returns renderer/resource state,
rolling 120-sample CPU mean/p95/p99, tracking camera/worker state, microphone,
recording and control-listener state. Renderer instances also expose
`diagnostics()`. Counts and texture/surface bytes are estimates, not OS/GPU heap
measurements.

Run with a local server and Playwright installed:

```sh
KOKORO_TEST_URL=http://127.0.0.1:5173 python3 scripts/benchmark-lifecycle.py \
  --baseline-ref 83c45de --output /tmp/kokoro-lifecycle-benchmark.json
```

The benchmark compares the committed original renderer with the working renderer
using identical current model/texture dependencies. It uses synthetic small,
medium and large models with 4/32/128 independently textured, deformed 8×8 meshes,
640×480 viewport, 20 warmup frames, 120 measured frames, ten model replacements,
30 recorded frames per size and ten recording start/stop cycles per variant.
Raw results, timing method and user agent are in `heartbeat-benchmark.json`.
CPU render duration and RAF interval are reported separately; neither is a GPU
execution timer. This is a repeatable functional/performance sample, not a
multi-hour memory soak or artist-reviewed large-model workload.

| Synthetic model | Mean CPU ms before → after | p95 ms before → after | p99 ms before → after | Draws | Texture MiB | Load ms before → after | Mean switch ms before → after |
| --- | --- | --- | --- | --- | --- | --- | --- |
| small (4 layers) | 0.08 → 0.21 | 0.20 → 0.30 | 0.20 → 0.40 | 5 | 0.06 | 246 → 94 | 90 → 100 |
| medium (32 layers) | 0.41 → 0.61 | 0.50 → 0.80 | 0.60 → 0.80 | 33 | 2.00 | 755 → 739 | 750 → 757 |
| large (128 layers) | 1.37 → 2.00 | 1.60 → 2.30 | 1.90 → 2.40 | 129 | 32.00 | 3007 → 3033 | 3052 → 3012 |

The additional frame GL error check has a measurable CPU cost; these results
support reliability, not a speed improvement claim. Texture estimates and draw
counts are unchanged. Both variants released all ten cycle capture tracks and
ended with zero tracked layers/textures/surfaces after disposal. Successful
recordings exported nonempty WebM. Decode/load results depend on browser cache,
scheduling and hardware; one before/after run does not establish a loading speed
improvement.

## CI and changed files

`.github/workflows/check.yml` runs recursive JS syntax checks plus Node tests,
Python server tests, and Chromium/Firefox hardening and lifecycle checks on push
and PR. Browser jobs use a fixed Playwright version, a ten-minute bound, a local
loopback server and process cleanup. Failures propagate nonzero exit status.
The workflow calls the checked-in recursive checker directly, so it also works
without the pre-existing local `package.json` edit. Hosted CI did not execute: all jobs ended before any steps with the annotation
that recent account payments failed or the spending limit needs increasing.
The repository owner must resolve GitHub Billing & plans and rerun the workflow.
See [the blocked PR run](https://github.com/ethand91/Kokoro2D/actions/runs/38525370572).
Linux runner execution therefore remains unverified; local passes are not hosted
CI passes.

Runtime changes: `serve.py`, `src/app.js`, `src/viewer.js`,
`src/face-tracking.js`, `src/control-api.js`, `src/project-store.js`,
`src/renderer.js`, `src/recorder.js`.

Coverage/tooling: `tests/face-tracking.test.js`, `tests/control-api.test.js`,
`tests/renderer-lifecycle.test.js`, `tests/recorder-lifecycle.test.js`,
`tests/test_performance_server.py`, `tests/scene.test.js`,
`tests/browser_hardening.py`, `tests/browser_hardening.js`,
`tests/browser_lifecycle.py`, `tests/browser_rig.py`,
`tests/browser_performance.js`, `scripts/benchmark-lifecycle.py`, CI workflow,
this review, raw benchmark results, and the Phase 1 documentation link.

## Remaining risks and merge assessment

- Real MediaPipe inference/download failures with physical cameras, physical
  hot-unplug, Safari/OBS integration, driver resets and multi-hour sessions have
  not been tested here. Deterministic lifecycle tests cover cleanup, not inference
  accuracy. Context restoration still depends on browser/driver support.
- Recovery artwork hashes detect accidental corruption, not an attacker who can
  rewrite both IndexedDB data and its hashes. Browser storage can be evicted;
  portable project exports remain necessary backups. Cross-tab editing remains
  last-committed-write wins, with no conflict-resolution UI.
- Corrupted retained revisions defer artwork GC; unusual corruption can retain
  orphan artwork until that revision ages out or is repaired. Queue length and
  per-model budgets bound operations, but large pending models and simultaneous
  old/new GPU sets can still have substantial peak memory.
- Local processes and configured image-repair helpers are trusted. Remote
  deployments require TLS/authenticated proxy configuration and rate limiting;
  this phase does not add a hosted multi-user security model.
- Synthetic benchmarks cannot prove stable OS/GPU/heap usage over hours, and
  deeply composited/high-resolution artwork has higher surface memory demands.

The focused hardening changes are ready for review on the executed local checks.
**Merge readiness: Not ready** while hosted CI cannot start because of the account
billing/spending-limit blocker. Resolve that external setting and require the
actual PR workflow to pass. This assessment does not certify untested
hardware/deployments or mark later Heartbeat phases complete.

Pull request: [Kokoro2D #2](https://github.com/ethand91/Kokoro2D/pull/2), against `main`.
