import test from "node:test";
import assert from "node:assert/strict";
import { ControlInbox, parameterCommand, validControlCommand, sendControl } from "../src/control-api.js";
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const batch = (sequence = 1, events = [{ sequence: 1, command: { type: "reset" } }]) => new Response(JSON.stringify({ sequence, events }));
test("commands enforce finite values, own definitions, ranges, sizes and hold duration", () => {
  const definitions = { x: { min: -1, max: 1 }, broken: { min: 1, max: -1 } };
  assert.deepEqual(parameterCommand({ type: "parameters", values: { x: 99, unknown: 4, toString: 2, broken: 0 }, holdMs: 99999 }, definitions), { values: { x: 1 }, holdMs: 15000 });
  for (const values of [[], null, JSON.parse('{"__proto__":1}')]) assert.equal(parameterCommand({ type: "parameters", values }, definitions), null);
  for (const value of [NaN, Infinity, "1"]) assert.deepEqual(parameterCommand({ type: "parameters", values: { x: value } }, definitions).values, {});
  assert.equal(parameterCommand({ type: "parameters", values: {}, holdMs: Infinity }, definitions), null);
  assert.equal(validControlCommand({ type: "speech", text: "a".repeat(4001) }), false);
  assert.equal(validControlCommand({ type: "reset", padding: "a".repeat(16384) }), false);
  assert.equal(validControlCommand({ type: "shell" }), false);
});
test("outages back off with jitter, recovery resets delay, duplicate start shares one loop", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let requests = 0; const received = [];
  t.mock.method(globalThis, "fetch", async () => { requests++; if (requests < 4) throw new Error("offline"); return batch(); });
  const inbox = new ControlInbox(command => received.push(command), { random: () => 1 });
  const pending = inbox.start(); assert.equal(inbox.start(), pending); await flush();
  assert.equal(requests, 1); t.mock.timers.tick(249); await flush(); assert.equal(requests, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(requests, 2);
  t.mock.timers.tick(500); await flush(); assert.equal(requests, 3);
  t.mock.timers.tick(1000); await flush(); assert.equal(requests, 4); assert.equal(received.length, 1);
  t.mock.timers.tick(80); await flush(); assert.equal(requests, 5); assert.equal(received.length, 1);
  inbox.stop(); await pending; t.mock.timers.tick(10000); await flush(); assert.equal(requests, 5);
});
test("inflight cancellation ignores stale responses and restart owns one new loop", async t => {
  let resolveOld, signal; let requests = 0; const received = [];
  t.mock.method(globalThis, "fetch", (_, options) => {
    requests++; if (requests === 1) { signal = options.signal; return new Promise(resolve => { resolveOld = resolve; }); }
    return Promise.resolve(batch(2, [{ sequence: 2, command: { type: "reset" } }]));
  });
  const inbox = new ControlInbox(command => received.push(command)); const old = inbox.start(); inbox.stop(); assert.ok(signal.aborted);
  const next = inbox.start(); await flush(); resolveOld(batch()); await old;
  assert.equal(received.length, 1); assert.equal(inbox.cursor, 2); inbox.stop(); await next;
});
for (const [name, response] of [
  ["malformed JSON", () => new Response("{")],
  ["invalid sequence", () => batch(1, [{ sequence: -1, command: { type: "reset" } }])],
  ["out of order", () => batch(2, [{ sequence: 2, command: { type: "reset" } }, { sequence: 1, command: { type: "reset" } }])],
  ["oversized header", () => new Response("{}", { headers: { "Content-Length": String(6 * 1024 * 1024) } })],
  ["oversized body", () => new Response(" ".repeat(5 * 1024 * 1024 + 1))],
  ["invalid command", () => batch(1, [{ sequence: 1, command: { type: "parameters", values: { x: "unsafe" } } }])],
]) {
  test(`${name} leaves cursor and avatar unchanged`, async t => {
    const errors = [], received = []; t.mock.method(globalThis, "fetch", async () => response());
    const inbox = new ControlInbox(command => received.push(command), { onError: error => errors.push(error) }); const pending = inbox.start();
    await flush(); inbox.stop(); await pending; assert.equal(inbox.cursor, 0); assert.equal(received.length, 0); assert.equal(errors.length, 1);
  });
}
test("processing exceptions do not block later commands; server restart resets cursor", async t => {
  const received = [], errors = []; t.mock.method(globalThis, "fetch", async () => batch(2, [{ sequence: 1, command: { type: "reset" } }, { sequence: 2, command: { type: "reset" } }]));
  const inbox = new ControlInbox(command => { received.push(command); if (received.length === 1) throw new Error("handler failed"); }, { onError: error => errors.push(error) }); inbox.cursor = 99;
  const pending = inbox.start(); await flush(); inbox.stop(); await pending; assert.equal(inbox.cursor, 2); assert.equal(received.length, 2); assert.equal(errors.length, 1);
});
test("request timeout aborts stalled polls and stop cancels the backoff timer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let signal;
  t.mock.method(globalThis, "fetch", (_, options) => new Promise((_, reject) => { signal = options.signal; signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))); }));
  const inbox = new ControlInbox(() => {}, { requestTimeoutMs: 100 }); const pending = inbox.start(); t.mock.timers.tick(100); await flush(); assert.ok(signal.aborted); inbox.stop(); await pending;
});
test("sendControl rejects invalid payloads before making a request", async t => {
  const mocked = t.mock.method(globalThis, "fetch", async () => batch()); await assert.rejects(sendControl({ type: "shell" }), /Invalid/); assert.equal(mocked.mock.callCount(), 0);
});

test("visemes reject malformed/overlapping timing and preserve canonical and Rhubarb tracks", () => {
  assert.equal(validControlCommand({ type: "visemes", track: { segments: [{ viseme: "aa", t0: 0, t1: 100 }] } }), true);
  assert.equal(validControlCommand({ type: "visemes", track: { mouthCues: [{ value: "D", start: 0, end: .1 }] } }), true);
  for (const segments of [[null], [{viseme:"eval",t0:0,t1:100}], [{viseme:"aa",t0:100,t1:0}], [{viseme:"aa",t0:0,t1:100},{viseme:"PP",t0:50,t1:150}]]) {
    assert.equal(validControlCommand({ type: "visemes", track: { segments } }), false);
  }
});
