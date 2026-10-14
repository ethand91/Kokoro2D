const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
export function trackingValues(result, neutral = {}, sensitivity = 1) {
  const scores = Object.fromEntries((result.faceBlendshapes?.[0]?.categories ?? []).map(c => [c.categoryName, Number.isFinite(c.score) ? clamp(c.score) : 0]));
  const matrix = result.facialTransformationMatrixes?.[0]?.data;
  if (!matrix || matrix.length !== 16 || !Array.from(matrix).every(Number.isFinite)) return null;
  const yaw = Math.atan2(matrix[8], matrix[10]), pitch = Math.atan2(-matrix[9], Math.hypot(matrix[8], matrix[10])), roll = Math.atan2(matrix[1], matrix[5]);
  const value = (name) => clamp((scores[name] ?? 0) - (neutral[name] ?? 0));
  return {
    "head.yaw": clamp((yaw - (neutral.yaw ?? 0)) * sensitivity / .65, -1, 1),
    "head.pitch": clamp((pitch - (neutral.pitch ?? 0)) * sensitivity / .5, -1, 1),
    "head.roll": clamp((roll - (neutral.roll ?? 0)) * sensitivity / .5, -1, 1),
    "eyes.blink": 0,
    "eyes.blinkLeft": clamp((value("eyeBlinkLeft") - .12) / .6), "eyes.blinkRight": clamp((value("eyeBlinkRight") - .12) / .6),
    "eyes.squint": Math.max(value("eyeSquintLeft"), value("eyeSquintRight")),
    "eyes.lookX": clamp((value("eyeLookOutLeft")+value("eyeLookInRight")-value("eyeLookInLeft")-value("eyeLookOutRight"))*1.5,-1,1),
    "eyes.lookY": clamp((value("eyeLookDownLeft")+value("eyeLookDownRight")-value("eyeLookUpLeft")-value("eyeLookUpRight"))*1.5,-1,1),
    "brows.raise": clamp((value("browInnerUp")-Math.max(value("browDownLeft"),value("browDownRight")))*1.5,-1,1),
    "mouth.open": value("jawOpen"), "mouth.jaw": value("jawOpen"), "mouth.round": value("mouthPucker"),
    "mouth.smile": clamp((value("mouthSmileLeft")+value("mouthSmileRight")-value("mouthFrownLeft")-value("mouthFrownRight"))*.75,-1,1),
  };
}
export function trackingNeutral(result) {
  const scores = Object.fromEntries((result.faceBlendshapes?.[0]?.categories ?? []).map(c => [c.categoryName, Number.isFinite(c.score) ? clamp(c.score) : 0]));
  const m = result.facialTransformationMatrixes?.[0]?.data;
  if (!m || m.length !== 16 || !Array.from(m).every(Number.isFinite) || !result.faceLandmarks?.length) return null;
  return { ...scores, yaw: Math.atan2(m[8],m[10]), pitch: Math.atan2(-m[9],Math.hypot(m[8],m[10])), roll: Math.atan2(m[1],m[5]) };
}
// Each session owns its resources; cancellation settles startup even when the
// browser permission prompt or video.play() cannot themselves be cancelled.
export class FaceTracker {
  constructor(onValues, onStatus, { initializationTimeoutMs = 60000 } = {}) {
    Object.assign(this, { onValues, onStatus, initializationTimeoutMs, neutral: {}, sensitivity: 1, smoothing: .65, generation: 0, session: null });
  }
  get stream() { return this.session?.stream ?? null; }
  get video() { return this.session?.video ?? null; }
  get worker() { return this.session?.worker ?? null; }
  get active() { return this.session?.ready === true; }
  get starting() { return !!this.session && !this.session.ready; }
  calibrate() {
    const neutral = this.lastResult && trackingNeutral(this.lastResult);
    if (!neutral) throw new Error("Keep your face visible with eyes open to calibrate.");
    this.neutral = neutral; this.filtered = null;
  }
  async start() {
    this.stop();
    const session = this.session = { generation: ++this.generation, controller: new AbortController(), busy: false };
    const { signal } = session.controller;
    const current = () => this.session === session && !signal.aborted;
    const wait = operation => new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("Tracking cancelled.", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Webcam tracking requires camera support on localhost or HTTPS.");
      const permission = navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
      // A grant arriving after stop still belongs to the obsolete session.
      permission.then(stream => {
        if (!current()) stream.getTracks().forEach(track => track.stop());
        else session.stream = stream;
      }, () => {});
      await wait(permission);
      signal.throwIfAborted();
      const video = session.video = document.createElement("video");
      video.muted = true; video.playsInline = true; video.srcObject = session.stream;
      await wait(video.play());
      signal.throwIfAborted();
      const worker = session.worker = new Worker(new URL("./face-tracking-worker.js", import.meta.url), { type: "module" });
      await wait(new Promise((resolve, reject) => {
        session.timeout = setTimeout(() => reject(new Error("Tracking model download timed out.")), this.initializationTimeoutMs);
        worker.onerror = event => reject(new Error(event.message || "Tracking worker failed."));
        worker.onmessage = ({ data }) => {
          if (!current()) return;
          if (data.type === "ready") resolve();
          else if (data.error) reject(new Error(data.error));
        };
        worker.postMessage({ type: "init" });
      }));
      clearTimeout(session.timeout);
      signal.throwIfAborted();
      worker.onerror = event => {
        if (!current()) return;
        this.stop(); this.onStatus(event.message || "Tracking worker failed.");
      };
      worker.onmessage = ({ data }) => {
        if (!current()) return;
        session.busy = false;
        if (data.error) { this.stop(); this.onStatus(data.error); return; }
        this.lastResult = data.result;
        const values = trackingValues(data.result ?? {}, this.neutral, this.sensitivity);
        if (values) {
          const amount = 1 - clamp(this.smoothing);
          this.filtered ??= { ...values };
          for (const [id, value] of Object.entries(values)) this.filtered[id] += (value - this.filtered[id]) * (id.includes("blink") ? .8 : amount);
          this.onValues({ ...this.filtered });
        } else { this.filtered = null; this.onValues(null); }
      };
      session.timer = setInterval(async () => {
        if (!current() || session.busy || !video.videoWidth) return;
        session.busy = true;
        let image;
        try {
          image = await createImageBitmap(video);
          if (!current()) return;
          worker.postMessage({ type: "frame", image, timeMs: performance.now() }, [image]);
          image = null; // Ownership transferred to the worker.
        } catch (error) {
          if (current()) { session.busy = false; this.onStatus(error.message); }
        } finally { image?.close(); }
      }, 40);
      session.ready = true;
      this.onStatus("Webcam tracking active. Calibrate with a relaxed face.");
      return true;
    } catch (error) {
      if (!current()) return false;
      this.stop();
      throw error;
    }
  }
  stop() {
    const session = this.session;
    if (!session) return;
    this.session = null; ++this.generation;
    session.controller.abort(); clearInterval(session.timer); clearTimeout(session.timeout);
    if (session.worker) {
      session.worker.onmessage = session.worker.onerror = null;
      session.worker.terminate(); session.worker = null;
    }
    session.stream?.getTracks().forEach(track => track.stop()); session.stream = null;
    if (session.video) { session.video.pause(); session.video.srcObject = null; session.video = null; }
    this.lastResult = this.filtered = null;
    this.onValues(null);
  }
  dispose() { this.stop(); }
}
