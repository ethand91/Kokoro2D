import test from "node:test";
import assert from "node:assert/strict";
import { buildVisemeTrack, VisemeTalker, VISEME_SHAPES } from "../src/viseme-lipsync.js";
import { buildSpeechPerformance, sampleSpeechPerformance } from "../src/speech-performance.js";
import { PuppetMotion } from "../src/motion.js";
import { createModel } from "../src/model.js";

test("speech nods, question tilts, and negation shakes follow distinct words", () => {
  function sample(text, type) {
    const performance = buildSpeechPerformance(buildVisemeTrack(text));
    const gesture = performance.gestures.find(item => item.type === type);
    assert.ok(gesture, `${text} supplies a ${type}`);
    return { gesture, pose: sampleSpeechPerformance(performance, gesture.peak) };
  }
  assert.ok(sample("Wonderful today.", "nod").pose.pitch > 0.1);
  assert.ok(sample("Ready?", "question").pose.roll < -0.1);
  const { gesture } = sample("No thanks.", "shake");
  const performance = buildSpeechPerformance(buildVisemeTrack("No thanks."));
  const yaw = Array.from({ length: 100 }, (_, i) => sampleSpeechPerformance(performance,
    gesture.start + (gesture.end - gesture.start) * i / 100).yaw);
  assert.ok(Math.min(...yaw) < -0.02 && Math.max(...yaw) > 0.02);
});

test("long speech phrases glance aside then return, short phrases hold attention", () => {
  const long = buildSpeechPerformance(buildVisemeTrack("We have wonderful adventures waiting for us."));
  const phrase = long.phrases[0];
  assert.ok(sampleSpeechPerformance(long, phrase.start + (phrase.end - phrase.start) * 0.4).gaze.x > 0.3);
  assert.equal(sampleSpeechPerformance(long, phrase.end - 80).gaze.x, 0);
  const short = buildSpeechPerformance(buildVisemeTrack("Hi."));
  assert.equal(sampleSpeechPerformance(short, 50).gaze, null);
});

test("absolute sampling skips expired gestures and bounds every channel", () => {
  const performance = buildSpeechPerformance(buildVisemeTrack("No! Wonderful adventures? Never stop exploring."));
  const neutral = { yaw: 0, pitch: 0, roll: 0, sway: 0, blink: 0, gaze: null };
  assert.deepEqual(sampleSpeechPerformance(performance, -1), neutral);
  assert.deepEqual(sampleSpeechPerformance(performance, 60000), neutral);
  for (let t = 0; t < performance.totalMs + 500; t += 8) {
    for (const [id, value] of Object.entries(sampleSpeechPerformance(performance, t))) {
      if (id !== "gaze") assert.ok(Number.isFinite(value) && Math.abs(value) <= 1, id);
    }
  }
  // Sampling in another order does not queue up any missed gestures.
  const earlier = sampleSpeechPerformance(performance, 100);
  sampleSpeechPerformance(performance, 60000);
  assert.deepEqual(sampleSpeechPerformance(performance, 100), earlier);
});

test("speech uses declared motion channels, preserves expressions, and yields gaze to the pointer", () => {
  const model = createModel();
  model.parameters["expr.happy"] = { id: "expr.happy", min: 0, max: 1, default: 0 };
  const baseline = new PuppetMotion({ random: () => 0.5 });
  const speaking = new PuppetMotion({ random: () => 0.5 });
  const gaze = { x: -0.8, y: -0.4 };
  const speech = { yaw: 0.1, pitch: 0.2, roll: -0.2, sway: 0.1, blink: 0.9, gaze: { x: 0.8, y: 0.4 } };
  for (let t = 0; t <= 1000; t += 1000 / 120) {
    baseline.update(t, model, { gaze });
    speaking.update(t, model, { gaze, speech });
  }
  assert.equal(speaking.headGaze, baseline.headGaze);
  assert.equal(speaking.pose["eyes.lookX"], baseline.pose["eyes.lookX"]);
  assert.ok(speaking.pose["head.pitch"] > baseline.pose["head.pitch"] + 0.1);
  assert.ok(speaking.pose["head.roll"] < baseline.pose["head.roll"] - 0.1);
  assert.ok(speaking.pose["eyes.blink"] > 0.5);
  assert.equal(speaking.pose["expr.happy"], undefined);
  assert.equal(speaking.pose["body.breathe"], undefined);
  // The head carries mass, so the gesture eases out over about a second
  // rather than vanishing; give it time to settle all the way.
  for (let t = 1010; t <= 3800; t += 10) {
    baseline.update(t, model, { gaze });
    speaking.update(t, model, { gaze });
  }
  assert.ok(Math.abs(speaking.pose["head.pitch"] - baseline.pose["head.pitch"]) < 1e-6);
  assert.ok(speaking.speechBlink < 1e-6);
});

test("word boundaries align repeated tokens using original character offsets", () => {
  const talker = new VisemeTalker();
  const track = talker.speak("  hello   hello world", { startMs: 100, holdUntilStop: true });
  assert.deepEqual(track.charIndices, [2, 10, 16]);
  assert.equal(talker.syncWord(10, 1100), true);
  assert.equal(talker.elapsedAt(1100), track.times[1]);
  assert.deepEqual(talker.shapeAt(1100), VISEME_SHAPES.E);
  assert.equal(talker.syncWord(10, 1200), false, "repeated events cannot rewind the same word");
  assert.equal(talker.syncWord(2, 1300), false, "stale earlier events are ignored");
  assert.equal(talker.syncWord(11, 1400), false, "non-word offsets are ignored");
  assert.equal(talker.syncWord(NaN, 1400), false);
  assert.equal(talker.syncWord(16, Infinity), false);
});

test("a slow voice can resume after an estimate expires, then stop releases it", () => {
  const talker = new VisemeTalker();
  const track = talker.speak("hello world", { startMs: 0, holdUntilStop: true });
  const late = track.totalMs + 2000;
  assert.deepEqual(talker.shapeAt(late), VISEME_SHAPES.sil);
  assert.equal(talker.speaking, true);
  assert.equal(talker.syncWord(6, late), true);
  assert.ok(talker.shapeAt(late).open > 0);
  talker.stop();
  assert.equal(talker.shapeAt(late), null);
  assert.equal(talker.syncWord(6, late + 1), false);
});

test("bilabial consonants actually seal a previously open mouth", () => {
  const model = createModel();
  const motion = new PuppetMotion({ random: () => 0.5 });
  for (let t = 0; t <= 400; t += 10) motion.update(t, model, { mouth: VISEME_SHAPES.aa });
  assert.ok(motion.pose["mouth.open"] > 0.9);
  for (let t = 410; t <= 500; t += 10) motion.update(t, model, { mouth: VISEME_SHAPES.PP });
  assert.equal(motion.pose["mouth.open"], 0);
});
