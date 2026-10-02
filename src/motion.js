const clamp = (x, min = -1, max = 1) => Math.max(min, Math.min(max, x));
const smooth = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const STEP = 1 / 120;

// Every timing pair below is [minimum, extra random], in seconds. `calm` is the
// original performance; `energetic` turns faster, bobs constantly, blinks about
// twice as often and shifts its weight harder, which the chest springs answer.
export const STYLES = Object.freeze({
  calm: Object.freeze({
    turnRate: 0.31, turnSize: 0.32, tiltSize: 0.045, bob: 0, speechStrength: 0.7,
    headDeadZone: 0.3, headGain: 0.55, vorGain: 0.6, tiltFollow: 0,
    headRate: 9, eyeRate: 22, breathRate: 0.24, microsaccade: 0.016,
    blinkGap: [2.2, 3.2], doubleBlink: 0, blinkOnSaccade: 0.2, bounceDrive: 0.32,
    partialBlink: 0.18, lidFollow: 0.32, idleMouth: 0.1,
    shiftGap: [1.8, 3.6], shiftTime: [0.7, 0.5], shiftSize: 0.7, swaySize: 0.45,
    viewerGap: [1.6, 2.2], awayGap: [0.7, 1.6], glanceSize: [0.55, 0.3], settleSize: [0.1, 0.07],
  }),
  energetic: Object.freeze({
    turnRate: 0.62, turnSize: 0.42, tiltSize: 0.13, bob: 0.05, speechStrength: 1,
    headDeadZone: 0.16, headGain: 0.95, vorGain: 0.7, tiltFollow: 0.12,
    headRate: 16, eyeRate: 30, breathRate: 0.3, microsaccade: 0.022,
    blinkGap: [1.6, 2.7], doubleBlink: 0.25, blinkOnSaccade: 0.22, bounceDrive: 0.15,
    partialBlink: 0.25, lidFollow: 0.32, idleMouth: 0.22,
    shiftGap: [0.8, 1.9], shiftTime: [0.42, 0.35], shiftSize: 0.95, swaySize: 0.6,
    viewerGap: [1.1, 1.6], awayGap: [0.5, 1.3], glanceSize: [0.75, 0.38], settleSize: [0.14, 0.09],
  }),
});

const gap = (random, [minimum, extra]) => minimum + random() * extra;

// Postural sway is not periodic. Its power spectrum is 1/f - a bounded
// correlated random walk, not a sum of sines - and a sum of sines is exactly
// what a viewer's eye catches as a loop. This is a Voss-McCartney generator:
// octaves that each re-roll at half the rate of the last, summed. Interpolating
// each octave with a smoothstep keeps it continuous rather than stepped.
function pinkDrift(random, base, octaves = 5) {
  const levels = [];
  for (let index = 0; index < octaves; index += 1) {
    levels.push({ from: random() * 2 - 1, to: random() * 2 - 1, at: 0, span: base * 2 ** index });
  }
  return (time) => {
    let sum = 0;
    for (const level of levels) {
      while (time >= level.at + level.span) {
        level.from = level.to;
        level.to = random() * 2 - 1;
        level.at += level.span;
      }
      sum += level.from + (level.to - level.from) * smooth((time - level.at) / level.span);
    }
    // Independent octaves add in quadrature, so normalise by the square root of
    // their count: that puts two standard deviations at about 1, and makes the
    // amplitude these are multiplied by mean what it says.
    return sum / Math.sqrt(levels.length);
  };
}

// Position along a minimum-jerk trajectory. The nervous system plans point-to-
// point movement by minimising jerk, which gives a bell-shaped velocity profile:
// slow start, fast middle, slow stop. An exponential ease is the opposite shape
// - fastest at the very start - which is why lag-eased motion reads as robotic.
const minimumJerk = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (10 - 15 * t + 6 * t * t));

// Inspiration is about 40% of a breath and expiration the other 60%, so a sine
// is the wrong shape: a real chest rises faster than it falls.
function breathWave(phase) {
  const p = phase - Math.floor(phase);
  return p < 0.4 ? smooth(p / 0.4) * 2 - 1 : 1 - smooth((p - 0.4) / 0.6) * 2;
}

// Fixed simulation steps keep springs and blink timing independent of display FPS.
export class PuppetMotion {
  constructor({ random = Math.random, style = 'calm' } = {}) {
    this.random = random;
    this.setStyle(style);
    this.reset();
  }

  // Switching mid-performance keeps the current pose and springs: only the
  // constants change, so she speeds up rather than snapping to a new stance.
  setStyle(style) {
    this.styleName = typeof style === 'string' && STYLES[style] ? style : typeof style === 'string' ? 'calm' : 'custom';
    this.style = typeof style === 'string' ? (STYLES[style] ?? STYLES.calm) : { ...STYLES.calm, ...style };
  }

  reset() {
    this.time = 0;
    this.previous = null;
    this.remainder = 0;
    this.blinkAt = 2.5 + this.random() * 2;
    this.attention = { x: 0, y: 0, until: 1.4 + this.random() * 1.8 };
    this.shift = { from: 0, to: 0, at: 1.2 + this.random() * 2.4, duration: 0.8 };
    this.blinkAgain = false;
    this.blinkDepth = 1;
    this.speechBlink = 0;
    this.mouthIdle = { open: 0.02, until: 0 };
    this.atViewer = true;
    this.micro = { x: 0, y: 0, until: 0 };
    // Head movements are composed of discrete submovements that rarely overlap,
    // each with its own bell-shaped velocity profile.
    this.headMove = { from: 0, to: 0, at: -1, span: 1 };
    this.pitchMove = { from: 0, to: 0, at: -1, span: 1 };
    this.headGaze = 0;
    this.headGazePitch = 0;
    // Saccades are ballistic: 30-120ms, longer for a larger jump.
    this.saccade = { from: 0, to: 0, at: -1, span: 0.05 };
    this.saccadeY = { from: 0, to: 0, at: -1, span: 0.05 };
    this.drift = pinkDrift(this.random, 0.7, 4);
    this.driftY = pinkDrift(this.random, 0.9, 4);
    this.swayNoise = pinkDrift(this.random, 1.7);
    this.yawNoise = pinkDrift(this.random, 1.3);
    this.pitchNoise = pinkDrift(this.random, 2.1);
    this.rollNoise = pinkDrift(this.random, 2.6);
    this.shifted = 0;
    this.springs = new Map();
    this.pose = {};
    this.model = null;
  }

  // People in conversation look at their partner about 60% of the time and
  // avert for the rest. Sampling directions uniformly, as this used to, gives a
  // character who never quite meets your eye and never quite looks away either.
  attentionTarget() {
    if (this.time >= this.attention.until) {
      const style = this.style;
      this.atViewer = !this.atViewer;
      const [spreadX, spreadY] = this.atViewer ? style.settleSize : style.glanceSize;
      const previous = this.attention.x;
      // An aversion goes somewhere definite rather than hovering near centre.
      const away = (spread) => {
        const direction = this.random() < 0.5 ? -1 : 1;
        return direction * (spread * 0.45 + this.random() * spread * 0.55);
      };
      this.attention = {
        x: this.atViewer ? (this.random() * 2 - 1) * spreadX : away(spreadX),
        y: this.atViewer ? (this.random() * 2 - 1) * spreadY : away(spreadY),
        until: this.time + gap(this.random, this.atViewer ? style.viewerGap : style.awayGap),
      };
      // Fixations end with a saccade or a blink, and often both: a large gaze
      // shift frequently carries a blink with it.
      if (Math.abs(this.attention.x - previous) > 0.35 && this.random() < style.blinkOnSaccade) {
        this.blinkAt = Math.min(this.blinkAt, this.time + 0.04 + this.random() * 0.1);
      }
    }
    return this.attention;
  }

  // Retarget a submovement only when the goal has really moved, so submovements
  // stay discrete instead of smearing into a continuous chase.
  submove(move, goal, current, span, threshold) {
    if (move.at < 0 || Math.abs(goal - move.to) > threshold) {
      move.from = current;
      move.to = goal;
      move.at = this.time;
      move.span = span;
    }
    return move.from + (move.to - move.from) * minimumJerk((this.time - move.at) / move.span);
  }

  // A resting face has a closed mouth. The old idle ran a speech animation with
  // no audio behind it, leaving her silently mouthing words 37% of the time.
  restingMouth() {
    if(this.style.idleMouth===0)return 0;
    if (this.time >= this.mouthIdle.until) {
      const event = this.random() < this.style.idleMouth;
      this.mouthIdle = {
        open: event ? 0.1 + this.random() * 0.22 : 0.01 + this.random() * 0.035,
        until: this.time + (event ? 0.22 + this.random() * 0.45 : 1.4 + this.random() * 3.2),
      };
    }
    return this.mouthIdle.open;
  }

  // Even a held fixation is not still: the eye makes one or two microsaccades a
  // second. Without them a held gaze reads as a freeze.
  microsaccade() {
    if (this.time >= this.micro.until) {
      this.micro = {
        x: (this.random() * 2 - 1) * this.style.microsaccade,
        y: (this.random() * 2 - 1) * this.style.microsaccade * 0.6,
        until: this.time + 0.35 + this.random() * 0.9,
      };
    }
    return this.micro;
  }

  // Weight shifts keep the idle pose off an obvious loop, and their rate of
  // change is what hands the chest springs a transient worth answering.
  weightShift() {
    const shift = this.shift;
    if (this.time >= shift.at + shift.duration) {
      this.shift = {
        from: shift.to,
        to: (this.random() * 2 - 1) * this.style.shiftSize,
        at: this.time + gap(this.random, this.style.shiftGap),
        duration: gap(this.random, this.style.shiftTime),
      };
      return shift.to;
    }
    if (this.time <= shift.at) return shift.from;
    return shift.from + (shift.to - shift.from) * smooth((this.time - shift.at) / shift.duration);
  }

  // `mouth` is the general external mouth drive, {open, round, form}; whatever
  // produces it, microphone RMS or a viseme track. `microphone` remains as its
  // original name for callers that predate text-driven lip sync.
  update(timeMs, model, { active = true, gaze = null, microphone = null, mouth = null, speech = null } = {}) {
    const drive = mouth ?? microphone;
    if (this.model !== model) { this.reset(); this.model = model; }
    const dt = this.previous === null ? 0 : clamp((timeMs - this.previous) / 1000, 0, 0.1);
    this.previous = timeMs;
    if (!active) return this.pose;
    this.remainder += dt;
    while (this.remainder + 1e-9 >= STEP) {
      this.remainder -= STEP;
      this.time += STEP;
      this.step(model, gaze, drive, speech);
    }
    return this.pose;
  }

  step(model, gaze, microphone, speech = null) {
    const t = this.time;
    const style = this.style;
    const speechStrength = style.speechStrength;
    const speechGaze = speech?.gaze && speechStrength > 0
      ? { x: speech.gaze.x * Math.min(1, speechStrength), y: speech.gaze.y * Math.min(1, speechStrength) } : null;
    const look = gaze ?? speechGaze ?? this.attentionTarget();
    const drift = gaze ? 0 : Math.sin(t * 0.43) * 0.05;
    const shift = this.weightShift();
    const shiftRate = (shift - this.shifted) / STEP;
    this.shifted = shift;
    const micro = this.microsaccade();
    // Idle drift is pink noise rather than summed sines, so it never repeats.
    const yaw = this.yawNoise(t * style.turnRate * 3.2) * style.turnSize;
    const pitchIdle = this.pitchNoise(t * style.turnRate * 2.6) * style.turnSize * 0.34;
    // Always-on micro-bob, so she is never perfectly still between larger moves.
    const bob = Math.sin(t * 2.4) * style.bob + Math.sin(t * 4.1 + 0.7) * style.bob * 0.45;
    const breathe = breathWave(t * style.breathRate + 0.2) * 0.55;
    const resting = this.restingMouth();
    // Eye-head coordination. A small shift is made by the eyes alone; past a
    // dead zone the head joins in, and it is much slower than the eyes.
    const headReach = (value) => Math.sign(value) * Math.max(0, Math.abs(value) - style.headDeadZone) * style.headGain;
    // Track the gaze-driven part of the head separately. The eyes compensate
    // only this, never the idle sway or the breathing bob: a real head only
    // needs cancelling while it is carrying the eyes to a target, and
    // compensating the idle drift too leaves the eyes sliding against every
    // movement the head makes, which reads as dead rather than alive.
    // Head: a discrete submovement per gaze shift, on a minimum-jerk curve.
    const headGoalX = headReach(look.x);
    const headGoalY = headReach(look.y) * 0.6;
    const headSpan = clamp(0.18 + Math.abs(headGoalX - this.headGaze) * 0.5, 0.12, 0.6);
    this.headGaze = this.submove(this.headMove, headGoalX, this.headGaze, headSpan, 0.04);
    this.headGazePitch = this.submove(this.pitchMove, headGoalY, this.headGazePitch, headSpan, 0.04);
    // Eyes: ballistic saccades whose duration grows with the distance jumped,
    // 30ms for a flick and up to 120ms for a large one - the main sequence.
    const eyeGoalX = clamp(look.x - this.headGaze * style.vorGain);
    const eyeGoalY = clamp(look.y - this.headGazePitch * style.vorGain);
    const saccadeSpan = (goal, current) => clamp(0.03 + Math.abs(goal - current) * 0.11, 0.03, 0.12);
    const eyeX = this.submove(this.saccade, eyeGoalX, this.saccade.to, saccadeSpan(eyeGoalX, this.saccade.to), 0.02);
    const eyeY = this.submove(this.saccadeY, eyeGoalY, this.saccadeY.to, saccadeSpan(eyeGoalY, this.saccadeY.to), 0.02);
    // Between saccades the eye drifts slowly, under a degree, then a
    // microsaccade corrects it. A perfectly fixed eye reads as a glass one.
    const eyeDrift = this.drift(t * 0.55) * 0.006;
    const eyeDriftY = this.driftY(t * 0.5) * 0.004;
    const targets = {
      'head.yaw': yaw + this.headGaze + shift * 0.07 + bob * 0.35 + (speech?.yaw ?? 0) * speechStrength,
      'head.pitch': pitchIdle + this.headGazePitch + bob + (speech?.pitch ?? 0) * speechStrength,
      // Tilting into the glance is what makes a fast turn read as a head turn.
      'head.roll': -yaw * 0.22 + this.rollNoise(t * 0.5) * style.tiltSize - shift * 0.05 - look.x * style.tiltFollow + (speech?.roll ?? 0) * speechStrength,
      'body.sway': this.swayNoise(t * 0.42) * 0.22 + shift * style.swaySize + (speech?.sway ?? 0) * speechStrength,
      'body.breathe': breathe,
      // bounceDrive is per style: energetic shifts weight ~2x faster, so the
      // same coefficient would pin the chest springs at their limit.
      'body.bounce': clamp(breathe * 0.45 + shiftRate * style.bounceDrive),
      // The eyes arrive first and then hold the target while the head catches
      // up, counter-rotating in the orbit as it arrives. That counter-rotation
      // is the vestibulo-ocular reflex, and it is most of what separates a
      // head-and-eyes-move-together puppet from something that looks alive.
      'eyes.lookX': clamp(eyeX + eyeDrift + micro.x),
      'eyes.lookY': clamp(eyeY + eyeDriftY + micro.y),
      'mouth.open': (typeof microphone === 'object' ? microphone?.open : microphone) ?? resting,
      'mouth.form': microphone?.form ?? this.rollNoise(t * 0.11) * 0.3,
      'mouth.round': microphone?.round ?? Math.max(0, this.pitchNoise(t * 0.09)) * 0.25,
    };
    for (const [id, target] of Object.entries(targets)) {
      if (!model.parameters[id]) continue;
      const current = this.pose[id] ?? model.parameters[id].default;
      // eyes and head already carry their own minimum-jerk trajectories; a lag
      // on top would flatten the bell-shaped profile back out.
      const rate = id === 'mouth.open' ? (target === 0 ? 65 : target > current ? 32 : 24)
        : id.startsWith('eyes.') ? 90
        : id === 'body.bounce' ? 40
        : id.startsWith('head.') ? 45
        : 9;
      this.pose[id] = current + (target - current) * (1 - Math.exp(-rate * STEP));
      if(id==='mouth.open' && target===0 && this.pose[id]<.006)this.pose[id]=0;
    }
    const elapsed = t - this.blinkAt;
    let blink = 0;
    // The upper lid follows the eye down: looking down narrows the aperture.
    const lid = Math.max(0, this.pose['eyes.lookY'] ?? 0) * style.lidFollow;
    if (elapsed >= 0 && elapsed < 0.08) blink = smooth(elapsed / 0.08);
    else if (elapsed >= 0.08 && elapsed < 0.125) blink = 1;
    else if (elapsed >= 0.125 && elapsed < 0.305) blink = 1 - smooth((elapsed - 0.125) / 0.18);
    else if (elapsed >= 0.305) {
      // A double blink is a second one before the normal gap has elapsed.
      const again = !this.blinkAgain && this.random() < style.doubleBlink;
      this.blinkAgain = again;
      this.blinkAt = t + (again ? 0.11 + this.random() * 0.09 : gap(this.random, style.blinkGap));
      // Normal blinks close completely; only deliberate partial blinks stop
      // short. Consume both draws so the rest of the performance keeps its RNG.
      const partial = this.random() < style.partialBlink, depth = this.random();
      this.blinkDepth = partial ? 0.45 + depth * 0.25 : 1;
    }
    if (model.parameters['eyes.blink']) {
      const target = (speech?.blink ?? 0) * Math.min(1, speechStrength);
      this.speechBlink += (target - this.speechBlink) * (1 - Math.exp(-(target > this.speechBlink ? 45 : 24) * STEP));
      this.pose['eyes.blink'] = clamp(Math.max(blink * this.blinkDepth, lid, this.speechBlink), 0, 1);
    }

    for (const [index, physics] of (model.physics ?? []).entries()) {
      if (!model.parameters[physics.output] || !model.parameters[physics.input]) continue;
      const spring = this.springs.get(index) ?? { position: model.parameters[physics.output].default, velocity: 0 };
      const omega = clamp(Number.isFinite(physics.frequency) ? physics.frequency : 3.2, 0.1, 12) * Math.PI * 2;
      const damping = clamp(Number.isFinite(physics.damping) ? physics.damping : 0.72, 0.05, 2);
      const strength = Number.isFinite(physics.strength) ? physics.strength : 1;
      const target = (this.pose[physics.input] ?? model.parameters[physics.input].default) * strength;
      spring.velocity += (omega * omega * (target - spring.position) - 2 * damping * omega * spring.velocity) * STEP;
      spring.position += spring.velocity * STEP;
      this.springs.set(index, spring);
      this.pose[physics.output] = spring.position;
    }
    for (const [id, value] of Object.entries(this.pose)) {
      const parameter = model.parameters[id];
      this.pose[id] = clamp(value, parameter.min, parameter.max);
    }
  }
}
