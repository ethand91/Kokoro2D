import { speechShape } from "./speech.js";

// The microphone owns its stream. Recorders may borrow its tracks, never stop them.
export class MicrophoneController {
  constructor({ onLevel = () => {}, onState = () => {}, onDevices = () => {},
    mediaDevices = globalThis.navigator?.mediaDevices,
    permissions = globalThis.navigator?.permissions,
    AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext,
    requestFrame = callback => requestAnimationFrame(callback),
    cancelFrame = id => cancelAnimationFrame(id),
  } = {}) {
    Object.assign(this, { onLevel, onState, onDevices, mediaDevices, permissions, AudioContext, requestFrame, cancelFrame });
    this.state = "disabled";
    this.permission = "unknown";
    this.deviceId = "";
    this.session = null;
    this.generation = 0;
    this.disposed = false;
    this.devicesChanged = () => { this.refreshDevices().catch(() => {}); };
    mediaDevices?.addEventListener?.("devicechange", this.devicesChanged);
  }

  get stream() { return this.session?.stream ?? null; }
  get active() { return this.state === "enabled"; }

  #state(state, message = "") {
    this.state = state;
    this.onState({ state, permission: this.permission, message });
  }

  async refreshDevices() {
    if (this.disposed || !this.mediaDevices?.enumerateDevices) return [];
    const generation = this.generation;
    const devices = (await this.mediaDevices.enumerateDevices()).filter(device => device.kind === "audioinput");
    if (!this.disposed && generation === this.generation) this.onDevices(devices);
    return devices;
  }

  async #watchPermission(generation) {
    try {
      const status = await this.permissions?.query({ name: "microphone" });
      if (!status || this.disposed || generation !== this.generation) return;
      this.permission = status.state;
      this.permissionStatus = status;
      this.permissionChanged = () => {
        this.permission = status.state;
        if (status.state === "denied") this.disable("Microphone permission was revoked.");
      };
      status.addEventListener("change", this.permissionChanged);
    } catch { /* Permission querying is not supported by every browser. */ }
  }

  async enable(deviceId = "") {
    if (this.disposed) throw new Error("Microphone controller has been disposed.");
    if (this.active && this.deviceId === deviceId) return true;
    const generation = ++this.generation;
    await this.#release();
    if (generation !== this.generation || this.disposed) return false;
    this.deviceId = deviceId;
    this.#state("enabling", "Waiting for microphone permission…");
    let session;
    try {
      if (!this.mediaDevices?.getUserMedia || !this.AudioContext) {
        throw new Error("Microphone access requires a supported browser on localhost or HTTPS.");
      }
      const stream = await this.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
      session = { stream, frame: null };
      if (generation !== this.generation || this.disposed) { await this.#releaseSession(session); return false; }
      this.session = session;
      this.permission = "granted";
      const audio = session.audio = new this.AudioContext();
      const analyser = session.analyser = audio.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.55;
      session.source = audio.createMediaStreamSource(stream);
      session.source.connect(analyser);
      session.ended = () => { this.disable("Microphone disconnected. Select an input and enable it again."); };
      for (const track of stream.getTracks()) track.addEventListener("ended", session.ended);
      await audio.resume();
      if (generation !== this.generation || this.disposed) { await this.#releaseSession(session); return false; }
      const samples = new Uint8Array(analyser.fftSize);
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      const measure = () => {
        if (this.session !== session || this.disposed) return;
        try {
          analyser.getByteTimeDomainData(samples);
          analyser.getFloatFrequencyData(spectrum);
          this.onLevel(speechShape(samples, spectrum, audio.sampleRate, analyser.fftSize));
          session.frame = this.requestFrame(measure);
        } catch (error) { this.disable(`Microphone analysis stopped: ${error.message}`); }
      };
      this.#state("enabled", "Microphone is driving mouth openness and estimated shape");
      measure();
      this.#watchPermission(generation);
      this.refreshDevices().catch(() => {});
      return true;
    } catch (error) {
      await this.#releaseSession(session);
      if (generation !== this.generation || this.disposed) return false;
      if (this.session === session) this.session = null;
      this.onLevel(null);
      if (error.name === "NotAllowedError" || error.name === "SecurityError") this.permission = "denied";
      const message = this.permission === "denied"
        ? "Microphone permission denied. Allow microphone access in your browser's site settings, then try again."
        : `Microphone unavailable: ${error.message}`;
      this.#state("error", message);
      throw new Error(message, { cause: error });
    }
  }

  async #releaseSession(session) {
    if (!session || session.released) return;
    session.released = true;
    if (session.frame !== null) this.cancelFrame(session.frame);
    for (const track of session.stream.getTracks()) {
      if (session.ended) track.removeEventListener("ended", session.ended);
      track.stop();
    }
    session.source?.disconnect();
    session.analyser?.disconnect();
    try { await session.audio?.close(); } catch { /* Already closed. */ }
  }

  async #release() {
    const session = this.session;
    this.session = null;
    this.permissionStatus?.removeEventListener("change", this.permissionChanged);
    this.permissionStatus = null;
    this.onLevel(null);
    await this.#releaseSession(session);
  }

  async disable(message = "Microphone disabled") {
    ++this.generation;
    const released = this.#release();
    this.#state("disabled", message);
    await released;
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.mediaDevices?.removeEventListener?.("devicechange", this.devicesChanged);
    await this.disable();
  }
}
