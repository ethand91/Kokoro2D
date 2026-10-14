import { VISEME_SHAPES } from "./viseme-lipsync.js";
const REST = Object.freeze({ open: 0, round: 0, form: 0 });
const RHUBARB = { A: "PP", B: "SS", C: "E", D: "aa", E: "O", F: "U", G: "FF", H: "DD", X: "sil" };

// Milliseconds on the audio playback clock. Accept a canonical provider-neutral
// track or Rhubarb's seconds-based mouthCues, without guessing phonemes from text.
export function parseTimedVisemes(input) {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  const entries = data?.mouthCues?.map(cue => ({ viseme: RHUBARB[cue.value], t0: cue.start * 1000, t1: cue.end * 1000 })) ?? data?.segments;
  if (!Array.isArray(entries) || entries.length > 100000) throw new Error("Expected a viseme segments array or Rhubarb mouthCues.");
  let end = 0;
  const segments = entries.map(entry => {
    const { viseme, t0, t1 } = entry;
    if (!Object.hasOwn(VISEME_SHAPES, viseme) || ![t0,t1].every(Number.isFinite) || t0 < end || t1 <= t0 || t1 > 3600000) throw new Error("Visemes must use known shapes, increasing non-overlapping times, and a maximum one-hour duration.");
    end = t1; return { viseme, t0, t1 };
  });
  return { segments, totalMs: end };
}
export function timedVisemeShape(track, timeMs) {
  if (!Number.isFinite(timeMs) || !track?.segments.length) return { ...REST };
  const segments = track.segments;
  let low = 0, high = segments.length - 1, index = -1;
  while (low <= high) { const middle = (low+high)>>1; if(segments[middle].t0<=timeMs){index=middle;low=middle+1;}else high=middle-1; }
  const segment = segments[index];
  if (!segment || timeMs >= segment.t1) return { ...REST };
  const target = VISEME_SHAPES[segment.viseme];
  // Preserve the seal during bilabials; interpolate other arrivals over at most
  // 35 ms, bounded by the segment length so brief consonants still register.
  if (segment.viseme === "PP" || segment.viseme === "sil") return { ...target };
  const previous = segments[index-1], start = previous && previous.t1 === segment.t0 ? VISEME_SHAPES[previous.viseme] : REST;
  const t = Math.min(1, (timeMs-segment.t0)/Math.min(35,(segment.t1-segment.t0)*.3));
  const blend = t*t*(3-2*t);
  return Object.fromEntries(Object.keys(REST).map(key=>[key,start[key]+(target[key]-start[key])*blend]));
}
export class AudioVisemePlayer {
  constructor(audio) { this.audio=audio; this.track=null; this.url=null; }
  setAudio(file) {
    this.audio.pause(); if(this.url)URL.revokeObjectURL(this.url);
    this.url=URL.createObjectURL(file);this.audio.src=this.url;this.audio.load();
  }
  setTrack(input) { this.track=parseTimedVisemes(input); return this.track; }
  shape() { return this.audio.paused || this.audio.ended || !this.track ? null : timedVisemeShape(this.track,this.audio.currentTime*1000); }
  async prepareAudio() {
    if(!this.context){this.context=new AudioContext();this.output=this.context.createMediaStreamDestination();this.source=this.context.createMediaElementSource(this.audio);this.source.connect(this.context.destination);this.source.connect(this.output);}
    await this.context.resume();
  }
  dispose() { this.audio.pause();if(this.url)URL.revokeObjectURL(this.url);this.context?.close(); }
}
