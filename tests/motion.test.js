import test from 'node:test';
import assert from 'node:assert/strict';
import { PuppetMotion, STYLES } from '../src/motion.js';
import { createModel, createLayer, ensureKeyform, evaluateLayer } from '../src/model.js';
import { attachToPortrait } from '../src/rig.js';

// A real sequence. With a constant RNG the pink-noise drift is zero and every
// autonomous choice lands on its midpoint, so she holds perfectly still.
function lcg(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function simulate(fps) {
  // A constant RNG leaves the pink-noise drift identically zero, which would
  // make this pass without testing anything.
  const motion = new PuppetMotion({ random: lcg(17) });
  const model = createModel();
  for (let frame = 0; frame <= fps * 10; frame++) motion.update(frame * 1000 / fps, model);
  return motion.pose;
}

test('motion produces the same pose at 30, 60, and 144 FPS', () => {
  const reference = simulate(60);
  for (const fps of [30, 144]) {
    for (const [id, value] of Object.entries(simulate(fps))) assert.ok(Math.abs(value - reference[id]) < 1e-9, id);
  }
});

test('blink fully closes, reopens, and stays within parameter limits', () => {
  const motion = new PuppetMotion({ random: () => 0 });
  const model = createModel();
  let closed = false;
  for (let frame = 0; frame <= 360; frame++) {
    const pose = motion.update(frame * 1000 / 120, model);
    closed ||= pose['eyes.blink'] === 1;
    for (const [id, value] of Object.entries(pose)) {
      assert.ok(Number.isFinite(value) && value >= model.parameters[id].min && value <= model.parameters[id].max);
    }
  }
  assert.ok(closed);
  assert.equal(motion.pose['eyes.blink'], 0);
});

test('gaze persists, microphone eases, pauses freeze, and long gaps stay bounded', () => {
  const motion = new PuppetMotion({ random: () => 0 });
  const model = createModel();
  for (let frame = 0; frame <= 120; frame++) motion.update(frame * 1000 / 120, model, { gaze: { x: 0.8, y: -0.5 }, microphone: 1 });
  // The eye no longer carries the whole gaze on its own: the head takes a share
  // and the eye counter-rotates against that share. The idle sway is not part
  // of it, so the direction that must hold is eye plus gaze-driven head.
  const combined = motion.pose['eyes.lookX'] + motion.headGaze * STYLES.calm.vorGain;
  assert.ok(Math.abs(combined - 0.8) < 0.05, `combined gaze ${combined}`);
  assert.ok(motion.pose['mouth.open'] > 0.99);
  const pose = { ...motion.pose };
  motion.update(2000, model, { active: false });
  assert.deepEqual(motion.pose, pose);
  motion.update(2010, model, { microphone: 0 });
  assert.ok(motion.pose['mouth.open'] > 0 && motion.pose['mouth.open'] < 1);
  const time = motion.time;
  motion.update(200000, model);
  assert.ok(motion.time - time <= 0.101);
});

test('physics honors strength and only writes declared parameters', () => {
  const model = createModel();
  model.physics[0].strength = 0;
  const motion = new PuppetMotion();
  for (let frame = 0; frame <= 120; frame++) motion.update(frame * 1000 / 60, model);
  assert.equal(motion.pose['hair.motion'], 0);
  assert.equal(motion.pose['body.breathe'], undefined);
});

test('patch vertices inherit the actual portrait triangles, including combined channels', () => {
  const model = createModel();
  const portrait = createLayer({ name: 'base', src: '', width: 100, height: 100, columns: 1, rows: 1 });
  const patch = createLayer({ name: 'patch', src: '', width: 50, height: 50, columns: 1, rows: 1 });
  ensureKeyform(portrait, 'head.yaw', 1).offsets = [0, 0, 10, 2, 20, 4, 60, 12];
  ensureKeyform(portrait, 'head.pitch', 1).offsets.fill(2);
  attachToPortrait(patch, portrait);
  const pose = evaluateLayer(patch, { 'head.yaw': 1, 'head.pitch': 0.5 }, model.parameters);
  // First vertex lies in the upper triangle; last lies in the lower triangle.
  assert.equal(pose.vertices[0] - patch.mesh.vertices[0], 8.5);
  assert.equal(pose.vertices[6] - patch.mesh.vertices[6], 38.5);
  assert.equal(pose.transform.rotation, 0);
});

test('she looks around and shifts her weight with no pointer at all', () => {
  const model = createModel();
  const motion = new PuppetMotion({ random: lcg(7) });
  const looks = [];
  const sways = [];
  motion.update(0, model); // The first frame only establishes the clock.
  // A minute, not 30s: over 30s half of all seeds fell short of 0.5 on body
  // spread, so the floor was a coin flip. A frozen body scores near zero.
  for (let frame = 1; frame <= 120 * 60; frame++) {
    const pose = motion.update(frame * 1000 / 120, model);
    looks.push(pose['eyes.lookX']);
    sways.push(pose['body.sway']);
    for (const [id, value] of Object.entries(pose)) {
      assert.ok(value >= model.parameters[id].min && value <= model.parameters[id].max, id);
    }
  }
  const spread = (values) => Math.max(...values) - Math.min(...values);
  assert.ok(spread(looks) > 0.4, `eyes only moved ${spread(looks)}`);
  assert.ok(spread(sways) > 0.3, `body only moved ${spread(sways)}`);
});

test('chest springs overshoot their driver, oscillate, and match across display rates', () => {
  function run(fps) {
    const model = createModel();
    for (const id of ['body.bounce', 'chest.bounce']) model.parameters[id] = { id, name: id, min: -1, max: 1, default: 0 };
    model.physics = [{ id: 'chest', input: 'body.bounce', output: 'chest.bounce', strength: 0.85, frequency: 1.5, damping: 0.16 }];
    const motion = new PuppetMotion({ random: lcg(3) });
    const rows = [];
    motion.update(0, model);
    for (let frame = 1; frame <= fps * 20; frame++) {
      const pose = motion.update(frame * 1000 / fps, model);
      rows.push([pose['body.bounce'], pose['chest.bounce']]);
    }
    return { rows, pose: motion.pose };
  }
  const reference = run(120);
  assert.ok(Math.abs(run(30).pose['chest.bounce'] - reference.pose['chest.bounce']) < 1e-9);
  assert.ok(reference.rows.every(([, chest]) => Number.isFinite(chest)));
  // Underdamped: it passes its own target rather than tracking it, then crosses
  // back through rest. A critically damped spring would do neither.
  assert.ok(reference.rows.some(([drive, chest]) => Math.abs(chest) > Math.abs(drive * 0.85) + 0.02));
  const crossings = reference.rows.filter(([, chest], index) => index && chest * reference.rows[index - 1][1] < 0).length;
  assert.ok(crossings > 4, `chest only crossed rest ${crossings} times`);
});

// Measure a style the way a viewer reads it: how far she turns, how often she
// blinks, how hard the body moves. Three minutes, because blink counts over
// 90s vary enough between seeds that the ratio below failed on one in ten.
function profile(style, seconds = 180, seed = 13) {
  const model = createModel();
  model.parameters['body.bounce'] = { id: 'body.bounce', min: -1, max: 1, default: 0 };
  const motion = new PuppetMotion({ random: lcg(seed), style });
  motion.update(0, model);
  let blinks = 0, closed = false, still = 0;
  const yaw = [], roll = [], sway = [];
  for (let frame = 1; frame <= 120 * seconds; frame++) {
    const pose = motion.update(frame * 1000 / 120, model);
    if (pose['eyes.blink'] > 0.35 && !closed) { blinks += 1; closed = true; }
    if (pose['eyes.blink'] < 0.1) closed = false;
    yaw.push(pose['head.yaw']); roll.push(pose['head.roll']); sway.push(pose['body.sway']);
    if (frame > 1 && Math.abs(yaw.at(-1) - yaw.at(-2)) < 1e-4) still += 1;
  }
  const spread = (v) => Math.max(...v) - Math.min(...v);
  return {
    blinksPerMinute: blinks / seconds * 60,
    yaw: spread(yaw), roll: spread(roll), sway: spread(sway),
    stillFraction: still / (120 * seconds),
  };
}

test('energetic turns further, tilts more, blinks more often, and rests less', () => {
  const calm = profile('calm');
  const energetic = profile('energetic');
  // Both rates are pinned to their human ranges separately; this only has to
  // show the styles are clearly different.
  assert.ok(energetic.blinksPerMinute > calm.blinksPerMinute * 1.4,
    `${energetic.blinksPerMinute} vs ${calm.blinksPerMinute}`);
  assert.ok(energetic.yaw > calm.yaw * 1.25, `yaw ${energetic.yaw} vs ${calm.yaw}`);
  assert.ok(energetic.roll > calm.roll * 1.5, `roll ${energetic.roll} vs ${calm.roll}`);
  assert.ok(energetic.sway > calm.sway * 1.15, `sway ${energetic.sway} vs ${calm.sway}`);
  // stillFraction counts frames whose head pose barely changed; some are
  // unavoidable at a turning point, but the micro-bob should make them rarer.
  assert.ok(energetic.stillFraction < calm.stillFraction * 0.5,
    `${energetic.stillFraction} vs ${calm.stillFraction}`);
  for (const p of [calm, energetic]) {
    for (const value of [p.yaw, p.roll, p.sway]) assert.ok(value <= 2);
  }
});

test('a style switch keeps the pose and stays frame-rate independent', () => {
  function run(fps) {
    const model = createModel();
    const motion = new PuppetMotion({ random: lcg(5), style: 'calm' });
    motion.update(0, model);
    for (let frame = 1; frame <= fps * 6; frame++) motion.update(frame * 1000 / fps, model);
    const before = { ...motion.pose };
    motion.setStyle('energetic');
    assert.deepEqual(motion.pose, before); // no snap at the moment of the switch
    for (let frame = fps * 6 + 1; frame <= fps * 12; frame++) motion.update(frame * 1000 / fps, model);
    return motion.pose;
  }
  const reference = run(120);
  for (const [id, value] of Object.entries(run(30))) assert.ok(Math.abs(value - reference[id]) < 1e-9, id);
  assert.equal(new PuppetMotion({ style: 'nonsense' }).styleName, 'calm');
  assert.equal(new PuppetMotion({ style: { turnSize: 0.9 } }).style.blinkGap, STYLES.calm.blinkGap);
});

test('the eyes reach a target first and hand it to the head without losing it', () => {
  const model = createModel();
  const motion = new PuppetMotion({ random: () => 0.5, style: 'calm' });
  const gaze = { x: 0.8, y: 0 };
  motion.update(0, model);
  const at = (ms) => {
    const frames = Math.round(ms / 1000 * 120);
    while (motion.time * 120 < frames) motion.update((motion.previous ?? 0) + 1000 / 120, model, { gaze });
    return { eye: motion.pose['eyes.lookX'], head: motion.headGaze };
  };
  const early = at(170);
  const late = at(2000);
  // Early on the eye is doing most of the work and the head is still arriving.
  assert.ok(early.eye > early.head, `eye ${early.eye} head ${early.head}`);
  // Later the head has taken over and the eye has counter-rotated back toward
  // centre - the vestibulo-ocular reflex, not a drift.
  assert.ok(late.head > early.head, 'the head should still be arriving');
  assert.ok(late.eye < early.eye, 'the eye should counter-rotate as the head arrives');
  // Through the whole handoff the target is never lost.
  for (const sample of [early, late]) {
    const combined = sample.eye + sample.head * STYLES.calm.vorGain;
    assert.ok(Math.abs(combined - 0.8) < 0.06, `combined gaze ${combined}`);
  }
});

test('blink and breathing rates land in the human range', () => {
  for (const [style, blinkRange] of [['calm', [10, 21]], ['energetic', [20, 33]]]) {
    const model = createModel();
    model.parameters['body.breathe'] = { id: 'body.breathe', min: -1, max: 1, default: 0 };
    const motion = new PuppetMotion({ random: lcg(29), style });
    motion.update(0, model);
    const minutes = 3;
    let blinks = 0;
    let closed = false;
    let breaths = 0;
    let rising = false;
    let previous = 0;
    for (let frame = 1; frame <= 120 * 60 * minutes; frame++) {
      const pose = motion.update(frame * 1000 / 120, model);
      if (pose['eyes.blink'] > 0.35 && !closed) { blinks += 1; closed = true; }
      if (pose['eyes.blink'] < 0.1) closed = false;
      const breathing = pose['body.breathe'];
      if (breathing > previous && !rising) { rising = true; breaths += 1; }
      if (breathing < previous) rising = false;
      previous = breathing;
    }
    const blinkRate = blinks / minutes;
    const breathRate = breaths / minutes;
    assert.ok(blinkRate >= blinkRange[0] && blinkRate <= blinkRange[1], `${style} blinks ${blinkRate}/min`);
    // Resting adults breathe 12-20 times a minute.
    assert.ok(breathRate >= 12 && breathRate <= 20, `${style} breaths ${breathRate}/min`);
  }
});

test('idle drift does not repeat the way a sum of sines does', () => {
  const model = createModel();
  const motion = new PuppetMotion({ random: lcg(41), style: 'energetic' });
  motion.update(0, model);
  const yaw = [];
  for (let frame = 1; frame <= 120 * 120; frame++) yaw.push(motion.update(frame * 1000 / 120, model)['head.yaw']);
  const mean = yaw.reduce((a, b) => a + b, 0) / yaw.length;
  const variance = yaw.reduce((a, b) => a + (b - mean) ** 2, 0);
  const autocorrelation = (lag) => {
    let sum = 0;
    for (let i = 0; i < yaw.length - lag; i++) sum += (yaw[i] - mean) * (yaw[i + lag] - mean);
    return sum / variance;
  };
  let strongest = 0;
  // From 3s: within one head movement a smooth, heavy head is correlated with
  // itself, which is not repetition. A loop shows at long lags.
  for (let lag = 120 * 3; lag < 120 * 30; lag += 60) {
    strongest = Math.max(strongest, Math.abs(autocorrelation(lag)));
  }
  // The previous sum-of-sines idle scored 0.87 on this measure, at a 15s lag.
  assert.ok(strongest < 0.5, `idle repeats at ${strongest}`);
  assert.ok(Math.max(...yaw) - Math.min(...yaw) > 0.4, 'but it should still move');
});

test('a gaze shift moves the head on a bell-shaped velocity profile', () => {
  const model = createModel();
  const motion = new PuppetMotion({ random: lcg(3), style: 'calm' });
  motion.update(0, model);
  for (let frame = 1; frame <= 240; frame++) motion.update(frame * 1000 / 120, model, { gaze: { x: 0, y: 0 } });
  const travel = [];
  // The head carries mass, so a turn this size lands in about 0.6s - inside
  // the 0.4-0.8s a person's head takes for it.
  for (let frame = 241; frame <= 330; frame++) {
    motion.update(frame * 1000 / 120, model, { gaze: { x: 0.9, y: 0 } });
    travel.push(motion.headGaze);
  }
  const velocity = travel.slice(1).map((value, index) => value - travel[index]);
  const moving = velocity.filter((v) => v > 1e-6);
  const peak = velocity.indexOf(Math.max(...velocity));
  // Minimum jerk starts from rest, peaks in the middle, and returns to rest.
  // A first-order lag is fastest on its very first frame.
  assert.ok(velocity[0] < Math.max(...velocity) * 0.25, 'should not start at full speed');
  assert.ok(peak > moving.length * 0.25 && peak < moving.length * 0.75, `peak at frame ${peak} of ${moving.length}`);
  assert.ok(velocity.at(-1) < Math.max(...velocity) * 0.25, 'should come to rest');
});

test('a moving cursor turns the head smoothly rather than stop-start', () => {
  for (const style of ['calm', 'energetic']) {
    const model = createModel();
    const motion = new PuppetMotion({ random: lcg(9), style });
    motion.update(0, model);
    const yaw = [];
    for (let frame = 1; frame <= 120 * 12; frame++) {
      // Pointer events arrive at 60Hz, so the goal moves in small steps; each
      // one used to restart the head from rest, peaking at 97-177 here.
      const t = Math.floor(frame / 2) / 60;
      motion.update(frame * 1000 / 120, model, { gaze: { x: Math.sin(t * 1.1) * 0.85, y: 0 } });
      yaw.push(motion.headGaze);
    }
    const velocity = yaw.slice(1).map((value, index) => (value - yaw[index]) * 120);
    const jolt = Math.max(...velocity.slice(241).map((value, index) => Math.abs(value - velocity[240 + index]) * 120));
    assert.ok(jolt < 20, `${style} head jolts at ${jolt.toFixed(1)}/s²`);
  }
});

test('the body turns after the head, the way a Live2D body angle follows the face', () => {
  const run = (x) => {
    const model = createModel();
    const motion = new PuppetMotion({ random: lcg(21), style: 'energetic' });
    motion.update(0, model);
    const sway = [];
    for (let frame = 1; frame <= 120 * 4; frame++) sway.push(motion.update(frame * 1000 / 120, model, { gaze: { x, y: 0 } })['body.sway']);
    return sway;
  };
  // The same seed both ways, so weight shifts and drift cancel and only the
  // head's pull on the body is left.
  const right = run(0.9), left = run(-0.9);
  const lean = (frame) => (right[frame] - left[frame]) / 2;
  assert.ok(lean(479) > 0.1, `body only leaned ${lean(479)}`);
  // It lags: a quarter of a second in, the body has barely started.
  assert.ok(lean(30) < lean(479) * 0.25, `body led the head: ${lean(30)} of ${lean(479)}`);
});

test('she tilts her head when she meets your eye, and straightens when she looks away', () => {
  const model = createModel();
  const motion = new PuppetMotion({ random: lcg(11), style: 'energetic' });
  motion.update(0, model);
  const roll = { viewer: [], away: [] };
  for (let frame = 1; frame <= 120 * 120; frame++) {
    motion.update(frame * 1000 / 120, model);
    roll[motion.atViewer ? 'viewer' : 'away'].push(Math.abs(motion.tiltMove.to));
  }
  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(mean(roll.viewer) > 0.1, `tilted only ${mean(roll.viewer).toFixed(3)} at the viewer`);
  assert.equal(mean(roll.away), 0, 'a tilt held while looking away reads as a crick');
  // A pointer takes over attention, and the tilt goes with it.
  for (let frame = 1; frame <= 120; frame++) motion.update((motion.previous ?? 0) + 1000 / 120, model, { gaze: { x: 0.3, y: 0 } });
  assert.equal(motion.tiltMove.to, 0);
});

test('saccade duration grows with the distance jumped, within the main sequence', () => {
  const model = createModel();
  const motion = new PuppetMotion({ random: lcg(5), style: 'calm' });
  motion.update(0, model);
  const spans = [];
  for (const target of [0.05, 0.9]) {
    for (let frame = 1; frame <= 200; frame++) {
      motion.update((motion.previous ?? 0) + 1000 / 120, model, { gaze: { x: target, y: 0 } });
      if (motion.saccade.at === motion.time) spans.push(motion.saccade.span);
    }
  }
  assert.ok(spans.length >= 2, 'saccades should have been issued');
  for (const span of spans) assert.ok(span >= 0.03 && span <= 0.12, `${span * 1000}ms`);
  assert.ok(Math.max(...spans) > Math.min(...spans), 'a longer jump should take longer');
});

test('she meets your eye about as often as a person in conversation does', () => {
  for (const style of ['calm', 'energetic']) {
    const model = createModel();
    const motion = new PuppetMotion({ random: lcg(29), style });
    motion.update(0, model);
    let atViewer = 0;
    let samples = 0;
    for (let frame = 1; frame <= 120 * 180; frame++) {
      motion.update(frame * 1000 / 120, model);
      samples += 1;
      if (Math.abs(motion.attention.x) < 0.2 && Math.abs(motion.attention.y) < 0.2) atViewer += 1;
    }
    const share = atViewer / samples;
    // ~60% of a conversation is spent looking at the other person. Uniformly
    // sampled targets never meet your eye and never properly look away either.
    assert.ok(share > 0.5 && share < 0.72, `${style} looks at the viewer ${(share * 100).toFixed(0)}%`);
  }
});

test('her mouth rests when nothing is driving it', () => {
  const model = createModel();
  const motion = new PuppetMotion({ random: lcg(7), style: 'energetic' });
  motion.update(0, model);
  const open = [];
  for (let frame = 1; frame <= 120 * 120; frame++) open.push(motion.update(frame * 1000 / 120, model)['mouth.open']);
  const share = open.filter((value) => value > 0.1).length / open.length;
  // The idle used to run a speech animation with no audio behind it, leaving
  // her silently mouthing words 37% of the time.
  assert.ok(share < 0.12, `mouth open ${(share * 100).toFixed(0)}% of the time`);
  // Resting is not frozen: it should still move occasionally.
  assert.ok(Math.max(...open) > 0.08, 'the mouth should still do something');
  // A microphone still drives it.
  for (let frame = 1; frame <= 120; frame++) {
    motion.update((motion.previous ?? 0) + 1000 / 120, model, { microphone: 1 });
  }
  assert.ok(motion.pose['mouth.open'] > 0.9, 'a microphone should still open it');
});

test('the lid rides the eye downward and not every blink is a full one', () => {
  const model = createModel();
  const motion = new PuppetMotion({ random: lcg(13), style: 'calm' });
  motion.update(0, model);
  // Hold a downward gaze: the aperture should narrow even between blinks.
  let narrowed = 0;
  for (let frame = 1; frame <= 120 * 6; frame++) {
    const pose = motion.update(frame * 1000 / 120, model, { gaze: { x: 0, y: 0.9 } });
    if (pose['eyes.blink'] > 0.05 && pose['eyes.blink'] < 0.5) narrowed += 1;
  }
  assert.ok(narrowed > 120, `lid followed the gaze for only ${narrowed} frames`);

  // Over a long idle, some blinks should be partial rather than full closures.
  const fresh = new PuppetMotion({ random: lcg(31), style: 'energetic' });
  fresh.update(0, model);
  const peaks = [];
  let peak = 0;
  for (let frame = 1; frame <= 120 * 240; frame++) {
    const value = fresh.update(frame * 1000 / 120, model)['eyes.blink'];
    if (value > 0.35) peak = Math.max(peak, value);
    else if (peak > 0) { peaks.push(peak); peak = 0; }
  }
  assert.ok(peaks.length > 40, `only ${peaks.length} blinks`);
  assert.ok(peaks.some((value) => value < 0.8), 'some blinks should be partial');
  assert.ok(peaks.filter(value => value === 1).length > peaks.length * .6, 'most blinks should close completely');
});
