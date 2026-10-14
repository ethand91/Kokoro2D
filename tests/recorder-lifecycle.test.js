import test from "node:test";
import assert from "node:assert/strict";
import { StageRecorder } from "../src/recorder.js";

function setup({ failStart = false, failConstructor = false, noStop = false, empty = false } = {}) {
  const video = { stops: 0, stop() { this.stops++; } }, audio = { stops: 0, stop() { this.stops++; } };
  const stream = { getVideoTracks: () => [video], addTrack(track) { this.audio = track; } };
  globalThis.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor(stream) { if (failConstructor) throw new Error("constructor failure"); this.stream = stream; this.state = "inactive"; }
    start() { if (failStart) throw new Error("start failure"); this.state = "recording"; }
    stop() {
      this.state = "inactive";
      if (noStop) return;
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(empty ? [] : ["video bytes"]) });
        this.onstop?.();
      });
    }
  };
  globalThis.document = { createElement() {
    const canvas = { captureStream: () => stream };
    canvas.getContext = () => ({ canvas, createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, drawImage() {} });
    return canvas;
  } };
  const errors = [], source = { width: 640, height: 480 };
  const recorder = new StageRecorder(source, { stopTimeoutMs: 10, onError: error => errors.push(error) });
  return { recorder, video, audio, stream, errors };
}

test("stop is idempotent, releases capture resources and preserves borrowed microphone tracks", async () => {
  const e = setup(); e.recorder.start([e.audio]);
  assert.throws(() => e.recorder.start(), /already/);
  const first = e.recorder.stop(); assert.equal(e.recorder.stop(), first);
  assert.ok((await first).size > 0); assert.equal(e.video.stops, 1); assert.equal(e.audio.stops, 0);
  assert.equal(e.recorder.context, null); assert.equal(await e.recorder.stop(), null);
  e.recorder.start([e.audio]); await e.recorder.stop(); assert.equal(e.video.stops, 2);
});

for (const option of ["failStart", "failConstructor"]) {
  test(`${option} releases the capture stream and compositor`, () => {
    const e = setup({ [option]: true }); assert.throws(() => e.recorder.start([e.audio]));
    assert.equal(e.video.stops, 1); assert.equal(e.audio.stops, 0); assert.equal(e.recorder.context, null);
  });
}

test("context-loss cancellation resolves an in-flight stop and keeps microphone live", async () => {
  const e = setup({ noStop: true }); e.recorder.start([e.audio]);
  const pending = e.recorder.stop(); e.recorder.cancel(); e.recorder.cancel();
  assert.equal(await pending, null); assert.equal(e.video.stops, 1); assert.equal(e.audio.stops, 0);
});

test("stop timeout and encoder error release tracks and settle pending saves", async () => {
  const e = setup({ noStop: true }); e.recorder.start([e.audio]);
  await assert.rejects(e.recorder.stop(), /timed out/); assert.equal(e.video.stops, 1);
  e.recorder.start([e.audio]); const native = e.recorder.recorder;
  const pending = e.recorder.stop(); native.onerror({ error: new Error("encoder failed") });
  await assert.rejects(pending, /encoder failed/); assert.equal(e.errors.length, 1);
  assert.equal(e.audio.stops, 0); assert.equal(e.recorder.context, null);
});

test("empty output is discarded and unsolicited stop still cleans up", async () => {
  const e = setup({ empty: true }); e.recorder.start(); assert.equal(await e.recorder.stop(), null);
  e.recorder.start(); e.recorder.recorder.stop(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(e.recorder.active, false); assert.equal(e.recorder.context, null); assert.equal(e.video.stops, 2);
});

test("compositor failure discards the take, releases tracks, and permits another recording", async () => {
  const e = setup(); e.recorder.start([e.audio]);
  e.recorder.context.drawImage = () => { throw new Error("capture frame failed"); };
  e.recorder.frame(); assert.equal(e.video.stops, 1); assert.equal(e.audio.stops, 0);
  assert.equal(e.errors[0].message, "capture frame failed"); assert.equal(e.recorder.context, null);
  e.recorder.start(); assert.ok((await e.recorder.stop()).size > 0);
});
