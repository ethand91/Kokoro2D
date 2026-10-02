import { speechShape } from "./speech.js";
import { VisemeTalker } from "./viseme-lipsync.js";
import { buildSpeechPerformance, sampleSpeechPerformance } from "./speech-performance.js";
import { PuppetMotion, STYLES } from "./motion.js";
import { AUTOSAVE_KEY, defaultParameterValues, parseModel, validateModel } from "./model.js";
import { KokoroRenderer } from "./renderer.js";
import { createLayeredSampleModel } from "./sample.js";
import { StageRecorder, downloadRecording, recordingName, recordingSupported } from "./recorder.js";

const canvas = document.querySelector("#viewerCanvas");
const renderer = new KokoroRenderer(canvas);
const controls = document.querySelector("#viewerControls");
const status = document.querySelector("#viewerStatus");
const fileInput = document.querySelector("#viewerFile");
const expressionRow = document.querySelector("#expressionRow");
const EXPRESSION_FACES = { "expr.happy": "✨", "expr.sad": "😢", "expr.angry": "😠", "expr.confused": "❓" };
// Show what you just made. The Maker parks its work in localStorage, and a
// Viewer that ignored it always opened on the bundled sample instead - so the
// puppet you had just rigged was the one thing you could not look at.
function makerPuppet() {
  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY);
    if (!saved) return null;
    const candidate = JSON.parse(saved)?.model;
    return validateModel(candidate).length ? null : candidate;
  } catch {
    return null;
  }
}

let source = "sample";
let model = makerPuppet();
if (model) source = "maker";
else model = await createLayeredSampleModel();
let values = defaultParameterValues(model);
let demo = true;
let microphoneLevel = null;
let microphoneStream = null;
const motion = new PuppetMotion({ style: "energetic" });
let gaze = null;
let gazeAt = 0;
let lastControlSync = 0;
// A pointer parked on the canvas is not attention. Release it so the
// autonomous performance takes the eyes and head back.
const GAZE_HOLD_MS = 2000;

function statusMessage(message, tone = "neutral") {
  status.textContent = message;
  status.dataset.tone = tone;
}

function rebuildControls() {
  controls.replaceChildren();
  for (const parameter of Object.values(model.parameters)) {
    const row = document.createElement("label");
    row.className = "viewer-control";
    const name = document.createElement("span");
    name.textContent = parameter.name;
    const output = document.createElement("output");
    output.textContent = Number(values[parameter.id]).toFixed(2);
    const input = document.createElement("input");
    input.type = "range";
    input.min = parameter.min;
    input.max = parameter.max;
    input.step = (parameter.max - parameter.min) / 100;
    input.value = values[parameter.id];
    input.dataset.parameter = parameter.id;
    input.addEventListener("input", () => {
      demo = false;
      document.querySelector("#demoMode").checked = false;
      values[parameter.id] = Number(input.value);
      output.textContent = Number(input.value).toFixed(2);
    });
    row.append(name, output, input);
    controls.append(row);
  }
}

// Expressions are ordinary parameters, so the buttons only set values: they
// never pause the performance the way touching a slider does.
function rebuildExpressions() {
  expressionRow.replaceChildren();
  for (const parameter of Object.values(model.parameters)) {
    if (!parameter.id.startsWith("expr.")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "expression";
    button.dataset.expression = parameter.id;
    button.textContent = `${EXPRESSION_FACES[parameter.id] ?? "🙂"} ${parameter.name}`;
    button.addEventListener("click", () => setExpression(parameter.id));
    expressionRow.append(button);
  }
  expressionRow.hidden = !expressionRow.childElementCount;
}

function setExpression(id) {
  const next = values[id] >= 1 ? null : id;
  for (const parameter of Object.values(model.parameters)) {
    if (parameter.id.startsWith("expr.")) values[parameter.id] = parameter.id === next ? 1 : 0;
  }
  for (const button of expressionRow.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.expression === next);
    button.setAttribute("aria-pressed", String(button.dataset.expression === next));
  }
  syncControls();
}

function syncControls() {
  for (const input of controls.querySelectorAll("input")) {
    const value = values[input.dataset.parameter];
    input.value = value;
    input.previousElementSibling.textContent = Number(value).toFixed(2);
  }
}

async function setModel(nextModel, nextSource = source) {
  const errors=validateModel(nextModel);
  if(errors.length)throw new Error(errors.join('\n'));
  const previous=model;
  try {
    await renderer.setModel(nextModel);
  } catch(error) {
    await renderer.setModel(previous);
    throw error;
  }
  model=nextModel;source=nextSource;
  stopSpeaking();
  values=defaultParameterValues(model);
  demo=true;document.querySelector('#demoMode').checked=true;
  document.querySelector('#previewTalking').checked=false;
  gaze=null;motion.reset();
  const profile=model.meta.motion;
  styleSelect.value=STYLES[profile?.style]?profile.style:'energetic';
  tuned={};
  // File-provided tuning uses the same supported ranges as the visible knobs.
  for(const [id,,min,max] of TUNABLE) {
    const value=profile?.overrides?.[id];
    if(Number.isFinite(value))tuned[id]=Math.max(min,Math.min(max,value));
  }
  applyTuning();buildTuner();tunerStatus.textContent=profile?'Using this model’s motion profile.':'';
  document.querySelector("#puppetTitle").textContent = model.meta.name;
  document.querySelector("#puppetByline").textContent = model.meta.author
    ? `by ${model.meta.author}` : "anonymous puppet";
  rebuildControls();rebuildExpressions();
  const origin = source === "maker" ? "from the Maker" : source === "file" ? "from file" : "bundled sample";
  statusMessage(`${model.layers.length} layers loaded · ${origin} · playing`, "good");
  sampleButton.hidden = source === "sample";
}

// Serialize decoding/loading: a slow earlier file must not overwrite a later
// selection, and a failed file must leave the previous puppet usable.
let loadQueue=Promise.resolve();
function queueModel(factory,nextSource) {
  loadQueue=loadQueue.then(async()=>{
    try {await setModel(await factory(),nextSource);}
    catch(error){statusMessage(`Could not load model: ${error.message}`, 'bad');}
  });
  return loadQueue;
}
function loadFile(file) {
  if(!file)return;
  return queueModel(async()=>parseModel(await file.text()),'file');
}

// Text-driven lip sync. The microphone path can only hear loudness and
// spectral balance, so it cannot tell "ee" from "oo"; reading the words gives
// the real mouth shapes. The only thing left to guess is timing, so the
// speaking rate is measured from the synthesiser and remembered.
const SPEECH_RATE_KEY = "kokoro2d.speechRate";
const DEFAULT_CHARS_PER_SECOND = 15.5;

function storedSpeechRate() {
  try {
    const value = Number(localStorage.getItem(SPEECH_RATE_KEY));
    return value >= 4 && value <= 60 ? value : DEFAULT_CHARS_PER_SECOND;
  } catch { return DEFAULT_CHARS_PER_SECOND; }
}

const talker = new VisemeTalker({ charsPerSecond: storedSpeechRate() });
let speechPerformance = null;
let activeUtterance = null;
let mouthReleaseUntil = 0;
const SILENT_MOUTH = { open: 0, round: 0, form: 0 };

// predicted/actual is how much slower the voice really is than we assumed.
function learnSpeechRate(predictedMs, actualMs) {
  if (!(predictedMs > 0) || !(actualMs > 250)) return;
  const measured = talker.charsPerSecond * (predictedMs / actualMs);
  if (!(measured > 4 && measured < 60)) return;
  talker.charsPerSecond = talker.charsPerSecond * 0.6 + measured * 0.4;
  try { localStorage.setItem(SPEECH_RATE_KEY, String(talker.charsPerSecond)); } catch { /* private mode */ }
}

// Prefer a natural-sounding local voice over a robotic network one.
function pickSpeechVoice() {
  const voices = speechSynthesis.getVoices().filter((voice) => voice.lang.startsWith("en"));
  const liked = ["Samantha", "Ava", "Allison", "Google US English", "Microsoft Aria", "Karen", "Daniel"];
  for (const name of liked) {
    const match = voices.find((voice) => voice.name.startsWith(name));
    if (match) return match;
  }
  return voices.find((voice) => voice.localService) ?? voices[0] ?? null;
}

function previewSpeech(timeMs) {
  const t=timeMs/1000, phrase=t%5.3;
  const envelope=phrase<3.6?Math.sin(Math.PI*phrase/3.6)**.5:0;
  const syllable=Math.max(0,Math.sin(t*14)+.3*Math.sin(t*23));
  return {open:Math.min(.8,syllable*.65)*envelope,round:(.5+.5*Math.sin(t*6))*envelope,form:Math.sin(t*4.3)*.45*envelope};
}

function animate(timeMs) {
  if (gaze && timeMs - gazeAt > GAZE_HOLD_MS) gaze = null;
  const spoken = talker.shapeAt(timeMs);
  const drive = spoken ?? microphoneLevel ?? (timeMs < mouthReleaseUntil ? SILENT_MOUTH
    : document.querySelector('#previewTalking').checked ? previewSpeech(timeMs) : null);
  const speech = speechPerformance && document.querySelector('#speechGestures').checked
    ? sampleSpeechPerformance(speechPerformance, talker.elapsedAt(timeMs)) : null;
  const pose = motion.update(timeMs, model, { active: demo, gaze, mouth: drive, speech });
  if (demo) {
    Object.assign(values, pose);
    if (timeMs - lastControlSync >= 120) {
      syncControls();
      lastControlSync = timeMs;
    }
  }
  renderer.render(values);
  if (recorder.active) {
    recorder.frame();
    if (timeMs - lastRecordSync >= 250) {
      recordStatus.textContent = clock(recorder.elapsedMs);
      lastRecordSync = timeMs;
    }
  }
  requestAnimationFrame(animate);
}

// Live tuning. The numbers in STYLES are calibrated against published human
// figures, but whether the result *looks* alive is a judgement only a person
// watching her can make, so every perceptual knob is adjustable here.
const TUNABLE = [
  ["speechStrength", "Speech gestures", 0, 1.5, 0.05],
  ["turnSize", "Head turn size", 0, 1, 0.01],
  ["turnRate", "Head turn speed", 0.1, 1.4, 0.01],
  ["tiltSize", "Head tilt", 0, 0.4, 0.005],
  ["bob", "Micro-bob", 0, 0.15, 0.005],
  ["headDeadZone", "Head dead zone", 0, 0.6, 0.01],
  ["headGain", "Head follows gaze", 0, 1.5, 0.05],
  ["vorGain", "Eye counter-rotation", 0, 1, 0.05],
  ["headRate", "Head speed", 4, 30, 1],
  ["eyeRate", "Eye speed", 8, 40, 1],
  ["microsaccade", "Microsaccades", 0, 0.06, 0.002],
  ["breathRate", "Breathing (Hz)", 0.12, 0.5, 0.01],
  ["lidFollow", "Lid follows gaze", 0, 0.8, 0.02],
  ["idleMouth", "Idle mouth movement", 0, 0.6, 0.02],
  ["swaySize", "Body sway", 0, 1, 0.05],
  ["shiftSize", "Weight shift", 0, 1.5, 0.05],
  ["bounceDrive", "Chest jiggle", 0, 0.6, 0.01],
];

const tunerControls = document.querySelector("#tunerControls");
const tunerStatus = document.querySelector("#tunerStatus");
let tuned = {};

function baseStyle() {
  return STYLES[styleSelect.value] ?? STYLES.calm;
}

function applyTuning() {
  motion.setStyle({ ...baseStyle(), ...tuned });
}

function buildTuner() {
  const base = baseStyle();
  tunerControls.replaceChildren();
  for (const [key, label, min, max, step] of TUNABLE) {
    if (typeof base[key] !== "number") continue;
    const row = document.createElement("label");
    row.className = "tune-row";
    const name = document.createElement("span");
    name.textContent = label;
    const value = document.createElement("output");
    const input = document.createElement("input");
    input.type = "range";
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = tuned[key] ?? base[key];
    value.textContent = Number(input.value).toFixed(step < 0.01 ? 3 : 2);
    input.addEventListener("input", () => {
      tuned[key] = Number(input.value);
      value.textContent = Number(input.value).toFixed(step < 0.01 ? 3 : 2);
      applyTuning();
      tunerStatus.textContent = "Changed, not saved.";
    });
    row.append(name, value, input);
    tunerControls.append(row);
  }
}

document.querySelector("#tunerCopy").addEventListener("click", async () => {
  const base = baseStyle();
  const changed = Object.entries(tuned).filter(([key, value]) => value !== base[key]);
  if (!changed.length) {
    tunerStatus.textContent = "Nothing changed yet.";
    return;
  }
  const text = `// ${styleSelect.value}, tuned by eye\n`
    + changed.map(([key, value]) => `${key}: ${value},`).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    tunerStatus.textContent = `Copied ${changed.length} value(s).`;
  } catch {
    tunerStatus.textContent = text; // Clipboard blocked: read them off here.
  }
});

document.querySelector("#tunerReset").addEventListener("click", () => {
  tuned = {};
  motion.setStyle(styleSelect.value);
  buildTuner();
  tunerStatus.textContent = "Back to the shipped values.";
});

const styleSelect = document.querySelector("#motionStyle");
for (const name of Object.keys(STYLES)) styleSelect.add(new Option(name[0].toUpperCase() + name.slice(1), name));
styleSelect.value = motion.styleName;
styleSelect.addEventListener("change", () => {
  tuned = {};
  motion.setStyle(styleSelect.value);
  buildTuner();
  tunerStatus.textContent = "";
});
buildTuner();

document.querySelector("#openModel").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  loadFile(fileInput.files[0]);fileInput.value='';
});
const stage=document.querySelector('.viewer-stage-wrap');
let dragDepth=0;
for(const eventName of ['dragenter','dragover'])stage.addEventListener(eventName,event=>{
  event.preventDefault();if(eventName==='dragenter')dragDepth++;
  stage.classList.add('dragging');
});
stage.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;stage.classList.remove('dragging');}});
stage.addEventListener('drop',event=>{
  event.preventDefault();dragDepth=0;stage.classList.remove('dragging');loadFile(event.dataTransfer.files[0]);
});
document.querySelector('#previewTalking').addEventListener('change',()=>{
  demo=true;document.querySelector('#demoMode').checked=true;
});
const sampleButton = document.querySelector("#loadSample");
sampleButton.addEventListener("click",()=>queueModel(createLayeredSampleModel,'sample'));

// Keep up with the Maker while it is open in another tab. Only while the Viewer
// is actually showing the Maker's puppet: it must not yank a file you opened.
let syncTimer = 0;
window.addEventListener("storage", (event) => {
  if (event.key !== AUTOSAVE_KEY || source !== "maker") return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const updated = makerPuppet();
    if (updated && source==='maker') await queueModel(async()=>updated,'maker');
  }, 400);
});

document.querySelector("#demoMode").addEventListener("change", (event) => {
  demo = event.target.checked;
  if (!demo) microphoneLevel = null;
});
document.querySelector("#enableMic").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    microphoneStream = stream;
    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.55;
    await audio.resume();
    audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const spectrum = new Float32Array(analyser.frequencyBinCount);
    const measure = () => {
      analyser.getByteTimeDomainData(samples);
      analyser.getFloatFrequencyData(spectrum);
      microphoneLevel = speechShape(samples, spectrum, audio.sampleRate, analyser.fftSize);
      requestAnimationFrame(measure);
    };
    measure();
    demo = true;
    document.querySelector("#demoMode").checked = true;
    document.querySelector("#enableMic").textContent = "Microphone active";
    document.querySelector("#enableMic").disabled = true;
    statusMessage("Microphone is driving mouth openness and estimated shape", "good");
  } catch (error) {
    statusMessage(`Microphone unavailable: ${error.message}`, "bad");
  }
});

const speakTextInput = document.querySelector("#speakText");
const speakButton = document.querySelector("#speakButton");
const speakStopButton = document.querySelector("#speakStop");
const speakStatus = document.querySelector("#speakStatus");

function stopSpeaking() {
  // Invalidate callbacks before cancel(): some engines emit onend/onerror
  // asynchronously for the cancelled utterance, even after another is queued.
  const wasSpeaking = activeUtterance !== null;
  activeUtterance = null;
  talker.stop();
  speechPerformance = null;
  mouthReleaseUntil = performance.now() + 250;
  try { speechSynthesis.cancel(); } catch { /* nothing queued */ }
  speakButton.disabled = false;
  speakStatus.textContent = "";
  if (wasSpeaking) statusMessage("Speech stopped");
}

speakButton.addEventListener("click", () => {
  const text = speakTextInput.value.trim();
  if (!text) return;
  if (!("speechSynthesis" in window)) {
    statusMessage("This browser has no speech synthesis", "bad");
    return;
  }
  stopSpeaking();

  const utterance = new SpeechSynthesisUtterance(text);
  activeUtterance = utterance;
  speakButton.disabled = true;
  speakStatus.textContent = "Preparing voice…";
  const voice = pickSpeechVoice();
  if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }

  let startedAt = null;
  let predictedMs = 0;
  // Start the visemes in the same tick the audio starts, not when queued.
  utterance.onstart = () => {
    if (activeUtterance !== utterance) return;
    startedAt = performance.now();
    const track = talker.speak(text, { startMs: startedAt, holdUntilStop: true });
    predictedMs = track.totalMs;
    speechPerformance = buildSpeechPerformance(track);
    demo = true;
    document.querySelector("#demoMode").checked = true;
    speakButton.disabled = true;
    speakStatus.textContent = "speaking…";
  };
  utterance.onboundary = (event) => {
    if (activeUtterance === utterance && startedAt !== null && event.name === "word") {
      talker.syncWord(event.charIndex, performance.now());
    }
  };
  const finish = (failed = false) => {
    if (activeUtterance !== utterance) return;
    if (!failed && startedAt !== null) learnSpeechRate(predictedMs, performance.now() - startedAt);
    activeUtterance = null;
    talker.stop();
    speechPerformance = null;
    mouthReleaseUntil = performance.now() + 250;
    speakButton.disabled = false;
    speakStatus.textContent = failed ? "Voice could not play. Try another line."
      : `${talker.charsPerSecond.toFixed(1)} chars/s`;
    statusMessage(failed ? "Speech unavailable" : "Speech finished", failed ? "bad" : "good");
  };
  utterance.onend = () => finish();
  utterance.onerror = () => finish(true);

  try { speechSynthesis.speak(utterance); }
  catch { finish(true); return; }
  statusMessage("Reading the words for viseme lip sync", "good");
});

speakStopButton.addEventListener("click", stopSpeaking);
speakTextInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    if (!speakButton.disabled) speakButton.click();
  }
});
window.addEventListener("pagehide", stopSpeaking);

// Hand a client a file, not a screen share. Audio is included when the
// microphone is already running, so a voiced take needs no second pass.
const recorder = new StageRecorder(canvas);
const recordButton = document.querySelector("#recordButton");
const recordStatus = document.querySelector("#recordStatus");
let lastRecordSync = 0;
const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

if (!recordingSupported()) {
  recordButton.disabled = true;
  recordStatus.textContent = "unsupported here";
}

recordButton.addEventListener("click", async () => {
  if (recorder.active) {
    recordButton.disabled = true;
    recordButton.textContent = "Saving…";
    const blob = await recorder.stop();
    const name = recordingName(model.meta.name);
    if (blob) downloadRecording(blob, name);
    recordButton.classList.remove("recording");
    recordButton.textContent = "⏺ Record WebM";
    recordButton.disabled = false;
    recordStatus.textContent = blob ? `${(blob.size / 1e6).toFixed(1)} MB` : "";
    statusMessage(blob ? `Saved ${name}` : "Recording discarded", blob ? "good" : "bad");
    return;
  }
  try {
    const tracks = microphoneStream ? microphoneStream.getAudioTracks() : [];
    recorder.start(tracks);
    recordButton.classList.add("recording");
    recordButton.textContent = "⏹ Stop recording";
    recordStatus.textContent = clock(0);
    statusMessage(`Recording the stage${tracks.length ? " with microphone audio" : ""} · keep this tab visible`, "good");
  } catch (error) {
    statusMessage(`Cannot record: ${error.message}`, "bad");
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (!demo) return;
  const rect = canvas.getBoundingClientRect();
  gaze = {};
  gaze.x = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width - 0.5) * 2));
  gaze.y = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height - 0.5) * 2));
  gazeAt = performance.now();
});

canvas.addEventListener("pointerleave", () => { gaze = null; });

queueModel(async()=>model,source).then(() => requestAnimationFrame(animate));
