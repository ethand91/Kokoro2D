import test from "node:test";
import assert from "node:assert/strict";
import { MicrophoneController } from "../src/microphone.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const frames = new Map(), streams = [], contexts = [], levels = [], states = [], devices = [];
  let nextFrame = 0;
  const media = new EventTarget(), permission = new EventTarget();
  permission.state = "granted";
  media.enumerateDevices = async () => [{ kind: "audioinput", deviceId: "usb", label: "USB" }, { kind: "videoinput" }];
  function makeStream() {
    const track = new EventTarget();
    track.stops = 0; track.stop = () => track.stops++;
    const stream = { getTracks: () => [track], getAudioTracks: () => [track], track };
    streams.push(stream); return stream;
  }
  media.getUserMedia = async constraints => { media.constraints = constraints; return makeStream(); };
  class Audio {
    sampleRate = 48000;
    constructor() { this.closed = 0; this.nodes = []; contexts.push(this); }
    createAnalyser() {
      const node = { fftSize: 1024, frequencyBinCount: 512, disconnects: 0, disconnect() { this.disconnects++; },
        getByteTimeDomainData: a => a.fill(128), getFloatFrequencyData: a => a.fill(-100) };
      this.nodes.push(node); return node;
    }
    createMediaStreamSource() { const node = { connect() {}, disconnects: 0, disconnect() { this.disconnects++; } }; this.nodes.push(node); return node; }
    async resume() {}
    async close() { this.closed++; }
  }
  const mic = new MicrophoneController({ mediaDevices: media, permissions: { query: async () => permission }, AudioContext: Audio,
    requestFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; }, cancelFrame: id => frames.delete(id),
    onLevel: level => levels.push(level), onState: state => states.push(state), onDevices: value => devices.push(value),
  });
  return { mic, media, permission, makeStream, frames, streams, contexts, levels, states, devices, Audio };
}

test("enable, repeated enable, switch and disable own exactly one loop and release every audio graph", async () => {
  const e = setup(); await e.mic.enable(); await tick();
  assert.equal(e.frames.size, 1); assert.equal(e.mic.permission, "granted");
  await e.mic.enable(); assert.equal(e.streams.length, 1);
  await e.mic.enable("usb"); await tick();
  assert.deepEqual(e.media.constraints, { audio: { deviceId: { exact: "usb" } } });
  assert.equal(e.frames.size, 1); assert.equal(e.streams[0].track.stops, 1); assert.equal(e.contexts[0].closed, 1);
  await e.mic.disable(); await e.mic.disable();
  assert.equal(e.frames.size, 0); assert.equal(e.mic.stream, null); assert.equal(e.levels.at(-1), null);
  for (const context of e.contexts) { assert.equal(context.closed, 1); assert.ok(context.nodes.every(n => n.disconnects === 1)); }
  await e.mic.dispose();
});

test("cancelling a pending permission grant stops its late stream without creating audio nodes", async () => {
  const e = setup(); let grant;
  e.media.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  const enable = e.mic.enable(); await tick(); await e.mic.disable();
  const stream = e.makeStream(); grant(stream);
  assert.equal(await enable, false); assert.equal(stream.track.stops, 1);
  assert.equal(e.contexts.length, 0); assert.equal(e.frames.size, 0); await e.mic.dispose();
});

test("a late old device cannot overwrite a newer microphone session", async () => {
  const e = setup(); let grant;
  const normal = e.media.getUserMedia;
  e.media.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  const old = e.mic.enable("old"); await tick();
  e.media.getUserMedia = normal; await e.mic.enable("usb");
  const active = e.mic.stream, stale = e.makeStream(); grant(stale);
  assert.equal(await old, false); assert.equal(e.mic.stream, active); assert.equal(stale.track.stops, 1);
  assert.equal(e.frames.size, 1); await e.mic.dispose();
});

test("permission denial is actionable and audio initialization failure releases the acquired stream", async () => {
  const e = setup();
  e.media.getUserMedia = async () => { throw new DOMException("denied", "NotAllowedError"); };
  await assert.rejects(e.mic.enable(), /site settings/); assert.equal(e.mic.permission, "denied");
  e.media.getUserMedia = async () => e.makeStream();
  e.Audio.prototype.resume = async () => { throw new Error("audio failed"); };
  await assert.rejects(e.mic.enable(), /audio failed/);
  assert.equal(e.streams[0].track.stops, 1); assert.equal(e.contexts[0].closed, 1);
  assert.equal(e.frames.size, 0); await e.mic.dispose();
});

test("disable while AudioContext.resume is pending cannot restart analysis", async () => {
  const e = setup(); let resume;
  e.Audio.prototype.resume = () => new Promise(resolve => { resume = resolve; });
  const enable = e.mic.enable(); await tick();
  await e.mic.disable(); assert.equal(e.streams[0].track.stops, 1);
  resume(); assert.equal(await enable, false); assert.equal(e.frames.size, 0); assert.equal(e.contexts[0].closed, 1);
  await e.mic.dispose();
});

test("device unplug and permission revocation clean up; disposal detaches listeners", async () => {
  const e = setup(); await e.mic.enable(); await tick();
  e.streams[0].track.dispatchEvent(new Event("ended")); await tick();
  assert.equal(e.mic.state, "disabled"); assert.equal(e.frames.size, 0);
  await e.mic.enable(); await tick();
  e.permission.state = "denied"; e.permission.dispatchEvent(new Event("change")); await tick();
  assert.equal(e.mic.permission, "denied"); assert.equal(e.mic.stream, null);
  e.media.dispatchEvent(new Event("devicechange")); await tick(); assert.equal(e.devices.at(-1).length, 1);
  await e.mic.dispose(); const count = e.devices.length, stateCount = e.states.length;
  e.media.dispatchEvent(new Event("devicechange")); e.permission.dispatchEvent(new Event("change")); await tick();
  assert.equal(e.devices.length, count); assert.equal(e.states.length, stateCount);
});
