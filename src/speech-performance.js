// Text-timed conversational gestures, inspired by heads/life.js. These are
// animation cues from spelling and punctuation, not measured vocal prosody.
// Sample absolute time so returning from a hidden tab cannot replay old nods.
const clamp = (v) => Math.max(0, Math.min(1, v));
const travel = (v) => { const t = clamp(v); return t * t * t * (10 - 15 * t + 6 * t * t); };
const pulse = (time, start, peak, end) => time <= start || time >= end ? 0
  : time < peak ? travel((time - start) / (peak - start))
  : 1 - travel((time - peak) / (end - peak));
const neutral = () => ({ yaw: 0, pitch: 0, roll: 0, sway: 0, blink: 0, gaze: null });

export function buildSpeechPerformance(track) {
  const gestures = [];
  const phrases = [];
  let phraseStart = 0;
  let nextBeat = 0;
  for (let i = 0; i < track.words.length; i += 1) {
    const word = track.words[i];
    const core = word.replace(/[^\p{L}']/gu, "");
    const start = track.times[i];
    const end = start + track.durations[i] * 0.88;
    const span = end - start;
    const peak = start + Math.min(220, span * 0.45);
    if (/^(no|not|never|don't|can't|won't)$/i.test(core)) {
      gestures.push({ type: "shake", start, peak, end: Math.min(end + 120, start + 650) });
      nextBeat = start + 800;
    } else if (core.length >= 5 && start >= nextBeat) {
      gestures.push({ type: "nod", start: Math.max(0, start - 90), peak, end: Math.min(end + 120, peak + 380),
        strength: Math.min(1, 0.5 + core.length * 0.045) });
      nextBeat = start + 900;
    }
    if (/[,;:.!?…]["'”’)]*$/.test(word) || i === track.words.length - 1) {
      const phraseEnd = Math.min(track.totalMs, start + track.durations[i]);
      phrases.push({ start: track.times[phraseStart], end: phraseEnd, side: phrases.length % 2 ? -1 : 1 });
      if (/[?]["'”’)]*$/.test(word)) {
        gestures.push({ type: "question", start: Math.max(track.times[phraseStart], start - 180),
          peak: end, end: phraseEnd + 280 });
      }
      gestures.push({ type: "blink", start: end, peak: end + 80, end: end + 305 });
      phraseStart = i + 1;
    }
  }
  return { gestures, phrases, totalMs: track.totalMs };
}

export function sampleSpeechPerformance(performance, elapsedMs) {
  const pose = neutral();
  if (!performance || elapsedMs < 0 || elapsedMs > performance.totalMs + 305) return pose;
  for (const gesture of performance.gestures) {
    const amount = pulse(elapsedMs, gesture.start, gesture.peak, gesture.end);
    if (!amount) continue;
    if (gesture.type === "nod") {
      pose.pitch += amount * 0.16 * gesture.strength;
      pose.sway += amount * 0.045 * gesture.strength;
    } else if (gesture.type === "question") {
      pose.roll -= amount * 0.18;
      pose.pitch -= amount * 0.07;
    } else if (gesture.type === "shake") {
      const phase = (elapsedMs - gesture.start) / (gesture.end - gesture.start);
      pose.yaw += Math.sin(phase * Math.PI * 2) * amount * 0.2;
    } else if (gesture.type === "blink") pose.blink = Math.max(pose.blink, amount);
  }
  for (const phrase of performance.phrases) {
    const span = phrase.end - phrase.start;
    if (span < 1300 || elapsedMs < phrase.start || elapsedMs > phrase.end) continue;
    // Look aside while forming a long phrase, and meet the viewer again at its
    // end. The pointer still takes priority in the shared motion engine.
    const away = pulse(elapsedMs, phrase.start + 100, phrase.start + span * 0.4, phrase.end - 150);
    pose.gaze = { x: phrase.side * 0.38 * away, y: 0.1 * away };
    break;
  }
  return pose;
}
