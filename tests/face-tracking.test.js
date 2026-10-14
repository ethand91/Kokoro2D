import test from "node:test";
import assert from "node:assert/strict";
import { FaceTracker, trackingValues, trackingNeutral } from "../src/face-tracking.js";
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function setup(t, { playPending = false } = {}) {
  const requests = [], videos = [], workers = [], values = [], statuses = [], intervals = new Map();
  t.mock.method(globalThis, "setInterval", fn => { const id = {}; intervals.set(id, fn); return id; });
  t.mock.method(globalThis, "clearInterval", id => intervals.delete(id));
  const original = { navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"), document: globalThis.document, Worker: globalThis.Worker, createImageBitmap: globalThis.createImageBitmap };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia() { const request = deferred(); requests.push(request); return request.promise; } } } });
  globalThis.document = { createElement() { const pending = deferred(); const video = { srcObject: null, videoWidth: 640, pauses: 0, play: () => playPending ? pending.promise : Promise.resolve(), pause() { this.pauses++; }, pending }; videos.push(video); return video; } };
  globalThis.Worker = class { constructor() { workers.push(this); this.terminations = 0; } postMessage(data) { this.last = data; } terminate() { this.terminations++; } };
  globalThis.createImageBitmap = async () => ({ close() {} });
  t.after(() => {
    if (original.navigator) Object.defineProperty(globalThis, "navigator", original.navigator); else delete globalThis.navigator;
    for (const key of ["document", "Worker", "createImageBitmap"]) { if (original[key] === undefined) delete globalThis[key]; else globalThis[key] = original[key]; }
  });
  const tracker = new FaceTracker(value => values.push(value), status => statuses.push(status), { initializationTimeoutMs: 10 });
  t.after(() => tracker.dispose());
  const stream = () => { const track = { stops: 0, stop() { this.stops++; } }; return { track, getTracks: () => [track] }; };
  const grant = async (index = 0) => { const s = stream(); requests[index].resolve(s); await flush(); return s; };
  const ready = async () => { workers.at(-1).onmessage({ data: { type: "ready" } }); await flush(); };
  return { tracker, requests, videos, workers, intervals, values, statuses, stream, grant, ready };
}
test("stop settles a pending permission request; late grants release their tracks", async t => {
  const e = setup(t), pending = e.tracker.start(); e.tracker.stop(); e.tracker.stop();
  assert.equal(await pending, false); const s = await e.grant(); assert.equal(s.track.stops, 1); assert.equal(e.workers.length, 0); assert.equal(e.tracker.video, null);
});
test("stop during video.play detaches video and stale rejection cannot stop a newer session", async t => {
  const e = setup(t, { playPending: true }), first = e.tracker.start(), s = await e.grant();
  e.tracker.stop(); assert.equal(await first, false); assert.equal(s.track.stops, 1); assert.equal(e.videos[0].srcObject, null);
  const second = e.tracker.start(), next = await e.grant(1); e.videos[0].pending.reject(new Error("obsolete play")); await flush();
  assert.equal(e.tracker.stream, next); e.videos[1].pending.resolve(); await flush(); await e.ready(); assert.equal(await second, true);
});
test("worker initialization cancellation clears timeout and settles startup immediately", async t => {
  const e = setup(t), pending = e.tracker.start(), s = await e.grant(), worker = e.workers[0], late = worker.onmessage;
  e.tracker.stop(); assert.equal(await pending, false); late({ data: { type: "ready" } });
  assert.equal(worker.terminations, 1); assert.equal(s.track.stops, 1); assert.equal(e.intervals.size, 0); assert.equal(e.tracker.active, false);
});
for (const failure of ["permission", "play", "worker", "init error", "timeout"]) {
  test(`${failure} failure cleans up and permits retry`, async t => {
    const e = setup(t, { playPending: failure === "play" }), pending = e.tracker.start();
    const rejected = assert.rejects(pending);
    if (failure === "permission") e.requests[0].reject(new Error("denied"));
    else {
      const s = await e.grant();
      if (failure === "play") e.videos[0].pending.reject(new Error("play failed"));
      else if (failure === "worker") e.workers[0].onerror({ message: "worker failed" });
      else if (failure === "init error") e.workers[0].onmessage({ data: { error: "model failed" } });
      await rejected; assert.equal(s.track.stops, 1);
    }
    await rejected; assert.equal(e.tracker.session, null);
    const retry = e.tracker.start(); await e.grant(1); if (failure === "play") { e.videos[1].pending.resolve(); await flush(); }
    await e.ready(); assert.equal(await retry, true); e.tracker.stop(); assert.equal(e.intervals.size, 0);
  });
}
test("rapid replacement, late frames and bitmap completion cannot mutate current session", async t => {
  const e = setup(t), first = e.tracker.start(); const oldStream = await e.grant(); await e.ready(); await first;
  const worker = e.workers[0], late = worker.onmessage, bitmap = deferred(); globalThis.createImageBitmap = () => bitmap.promise;
  const frame = [...e.intervals.values()][0]();
  const next = e.tracker.start(); await e.grant(1); await e.ready(); await next;
  const count = e.values.length, statusCount = e.statuses.length;
  late({ data: { error: "old worker error" } }); const image = { closes: 0, close() { this.closes++; } }; bitmap.resolve(image); await frame;
  assert.equal(image.closes, 1); assert.equal(e.values.length, count); assert.equal(e.statuses.length, statusCount); assert.equal(e.tracker.active, true); assert.equal(oldStream.track.stops, 1);
  assert.equal(worker.terminations, 1); e.tracker.dispose(); assert.equal(e.intervals.size, 0);
});
test("late bitmap failures after disposal produce no status callbacks", async t => {
  const e = setup(t), pending = e.tracker.start(); await e.grant(); await e.ready(); await pending;
  const bitmap = deferred(); globalThis.createImageBitmap = () => bitmap.promise;
  const frame = [...e.intervals.values()][0](); e.tracker.dispose(); const count = e.statuses.length;
  bitmap.reject(new Error("decode failed")); await frame; assert.equal(e.statuses.length, count);
});
test("tracking rejects invalid matrices and sanitizes nonfinite blendshape scores", () => {
  const matrix = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const result = { facialTransformationMatrixes: [{ data: matrix }], faceLandmarks: [[]], faceBlendshapes: [{ categories: [{ categoryName: "jawOpen", score: NaN }] }] };
  assert.equal(trackingValues(result)["mouth.open"], 0);
  matrix[0] = Infinity; assert.equal(trackingValues(result), null); assert.equal(trackingNeutral(result), null);
});

test("runtime worker errors release the active camera and allow a fresh session", async t => {
  const e = setup(t), pending = e.tracker.start(), s = await e.grant(); await e.ready(); await pending;
  e.workers[0].onerror({ message: "runtime failure" });
  assert.equal(e.tracker.active, false); assert.equal(s.track.stops, 1); assert.equal(e.intervals.size, 0); assert.equal(e.statuses.at(-1), "runtime failure");
  const retry = e.tracker.start(); await e.grant(1); await e.ready(); assert.equal(await retry, true);
});
test("failed frame transfer closes the untransferred bitmap", async t => {
  const e = setup(t), pending = e.tracker.start(); await e.grant(); await e.ready(); await pending;
  const image = { closes: 0, close() { this.closes++; } }; globalThis.createImageBitmap = async () => image;
  e.workers[0].postMessage = () => { throw new Error("transfer failed"); };
  await [...e.intervals.values()][0](); assert.equal(image.closes, 1); assert.equal(e.statuses.at(-1), "transfer failed"); assert.equal(e.tracker.session.busy, false);
});
