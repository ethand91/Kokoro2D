// Showcase capture for the Viewer. Recording the stage canvas directly is the
// obvious move and it is wrong twice: the renderer clears to transparent, which
// encodes as a black void, and `renderer.resize()` retargets the backing store
// whenever the window moves, which changes the video track's frame size
// mid-take and leaves a file players seek through badly or refuse outright. So
// a take is composited into a canvas of its own, at a size fixed when recording
// starts and over the same backdrop the stage shows.
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
];

export function pickMimeType(withAudio = false) {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_CANDIDATES.filter(type => withAudio || !type.includes('opus'))
    .find(type => MediaRecorder.isTypeSupported(type)) ?? null;
}

export function recordingSupported() {
  return pickMimeType() !== null
    && typeof HTMLCanvasElement !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

export function recordingName(title) {
  const slug = String(title || 'kokoro2d').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  return `${slug || 'kokoro2d'}-${stamp}.webm`;
}

export function downloadRecording(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link); link.click(); link.remove();
  // Revoking in the same tick cancels the save in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export class StageRecorder {
  constructor(source, { fps = 60, backdrop = ['#39264c', '#160f1e'] } = {}) {
    Object.assign(this, { source, fps, backdrop, recorder: null, context: null, chunks: [], startedAt: 0 });
  }

  get active() { return this.recorder?.state === 'recording'; }
  get elapsedMs() { return this.active ? performance.now() - this.startedAt : 0; }

  start(audioTracks = []) {
    const mimeType = pickMimeType(audioTracks.length > 0);
    if (!mimeType) throw new Error('this browser cannot record WebM');
    // Even dimensions: an odd frame size makes some encoders fail silently.
    const width = Math.max(2, Math.round(this.source.width / 2) * 2);
    const height = Math.max(2, Math.round(this.source.height / 2) * 2);
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    this.context = canvas.getContext('2d');
    this.gradient = this.context.createRadialGradient(width / 2, height * .42, 0, width / 2, height * .42, Math.max(width, height) * .62);
    this.gradient.addColorStop(0, this.backdrop[0]);
    this.gradient.addColorStop(1, this.backdrop[1]);
    this.frame();
    const stream = canvas.captureStream(this.fps);
    for (const track of audioTracks) stream.addTrack(track);
    this.chunks = [];
    this.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12e6 });
    this.recorder.ondataavailable = event => { if (event.data.size) this.chunks.push(event.data); };
    // Timeslice, so an interrupted take still has everything up to the cut.
    this.recorder.start(1000);
    this.startedAt = performance.now();
    return mimeType;
  }

  // One composited frame per rendered frame. Fitted rather than stretched: the
  // window can change shape mid-take and must not squash the character.
  frame() {
    if (!this.context) return;
    const { width, height } = this.context.canvas;
    const scale = Math.min(width / this.source.width, height / this.source.height);
    const w = this.source.width * scale, h = this.source.height * scale;
    this.context.fillStyle = this.gradient;
    this.context.fillRect(0, 0, width, height);
    this.context.drawImage(this.source, (width - w) / 2, (height - h) / 2, w, h);
  }

  async stop() {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') return null;
    await new Promise(resolve => { recorder.onstop = resolve; recorder.stop(); });
    this.recorder = null; this.context = null;
    // Only the video track is ours. Stopping the borrowed microphone tracks
    // here would end the lip sync the moment a recording finished.
    for (const track of recorder.stream.getVideoTracks()) track.stop();
    return new Blob(this.chunks, { type: 'video/webm' });
  }
}
