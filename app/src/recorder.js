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
  constructor(source, { fps = 60, backdrop = ['#39264c', '#160f1e'], onError = () => {}, stopTimeoutMs = 5000 } = {}) {
    Object.assign(this, { source, fps, backdrop, onError, stopTimeoutMs, recorder: null, context: null, chunks: [], startedAt: 0, stopping: null, stream: null });
  }

  get active() { return this.recorder?.state === 'recording'; }
  get elapsedMs() { return this.active ? performance.now() - this.startedAt : 0; }

  start(audioTracks = []) {
    if (this.recorder || this.stopping) throw new Error("A recording is already in progress.");
    try {
      const mimeType = pickMimeType(audioTracks.length > 0);
      if (!mimeType) throw new Error('this browser cannot record WebM');
      // Even dimensions: an odd frame size makes some encoders fail silently.
      const width = Math.max(2, Math.round(this.source.width / 2) * 2);
      const height = Math.max(2, Math.round(this.source.height / 2) * 2);
      const canvas = Object.assign(document.createElement('canvas'), { width, height });
      this.context = canvas.getContext('2d');
      if (!this.context) throw new Error('Unable to create recording canvas.');
      this.gradient = this.context.createRadialGradient(width / 2, height * .42, 0, width / 2, height * .42, Math.max(width, height) * .62);
      this.gradient.addColorStop(0, this.backdrop[0]);
      this.gradient.addColorStop(1, this.backdrop[1]);
      this.frame();
      const stream = this.stream = canvas.captureStream(this.fps);
      for (const track of audioTracks) stream.addTrack(track);
      this.chunks = [];
      this.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12e6 });
      this.recorder.ondataavailable = event => { if (event.data.size) this.chunks.push(event.data); };
      this.recorder.onerror = event => {
        const error = event.error ?? new Error('MediaRecorder failed.');
        this.#finish(error);
        this.onError(error);
      };
      this.recorder.onstop = () => {
        if (this.stopping) this.#finish();
        else {
          const error = new Error('Recording ended unexpectedly. The interrupted take was discarded.');
          this.#finish(error);
          this.onError(error);
        }
      };
      // Collect periodic chunks while recording; interrupted takes are discarded.
      this.recorder.start(1000);
      this.startedAt = performance.now();
      return mimeType;
    } catch (error) {
      this.cancel();
      throw error;
    }
  }

  // One composited frame per rendered frame. Fitted rather than stretched: the
  // window can change shape mid-take and must not squash the character.
  frame() {
    if (!this.context) return;
    try {
      const { width, height } = this.context.canvas;
      const scale = Math.min(width / this.source.width, height / this.source.height);
      const w = this.source.width * scale, h = this.source.height * scale;
      this.context.fillStyle = this.gradient;
      this.context.fillRect(0, 0, width, height);
      this.context.drawImage(this.source, (width - w) / 2, (height - h) / 2, w, h);
    } catch (error) {
      // A failed compositor must not kill the Viewer's animation loop.
      if (!this.recorder) throw error;
      this.#finish(error); this.onError(error);
    }
  }

  stop() {
    if (this.stopping) return this.stopping;
    if (!this.recorder) return Promise.resolve(null);
    this.stopping = new Promise((resolve, reject) => { this.resolveStop = resolve; this.rejectStop = reject; });
    const pending = this.stopping;
    this.stopTimer = setTimeout(() => this.#finish(new Error('Recording stop timed out.')), this.stopTimeoutMs);
    try {
      // An inactive recorder may still have its final data and stop events queued.
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    } catch (error) { this.#finish(error); }
    return pending;
  }

  #finish(error = null, discard = false) {
    const resolve = this.resolveStop, reject = this.rejectStop;
    const blob = !error && !discard && this.chunks.length ? new Blob(this.chunks, { type: 'video/webm' }) : null;
    clearTimeout(this.stopTimer);
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder) {
      recorder.ondataavailable = recorder.onstop = recorder.onerror = null;
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* Already interrupted. */ }
    }
    // Only video tracks belong to this capture. Audio is borrowed from lip sync.
    for (const track of this.stream?.getVideoTracks() ?? []) track.stop();
    this.stream = this.context = this.gradient = null;
    this.chunks = [];
    this.stopping = this.resolveStop = this.rejectStop = null;
    if (error) reject?.(error);
    else resolve?.(blob);
  }

  cancel() { this.#finish(null, true); }
}
