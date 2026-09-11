import { defaultParameterValues, parseModel } from "./model.js";
import { KokoroRenderer } from "./renderer.js";
import { createSampleModel } from "./sample.js";

const canvas = document.querySelector("#viewerCanvas");
const renderer = new KokoroRenderer(canvas);
const controls = document.querySelector("#viewerControls");
const status = document.querySelector("#viewerStatus");
const fileInput = document.querySelector("#viewerFile");
let model = createSampleModel();
let values = defaultParameterValues(model);
let demo = true;
let microphoneLevel = null;
let blinkAt = 2.8;
let blinkStarted = null;
const spring = { position: 0, velocity: 0 };

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

function syncControls() {
  for (const input of controls.querySelectorAll("input")) {
    const value = values[input.dataset.parameter];
    input.value = value;
    input.previousElementSibling.textContent = Number(value).toFixed(2);
  }
}

async function setModel(nextModel) {
  model = nextModel;
  values = defaultParameterValues(model);
  await renderer.setModel(model);
  document.querySelector("#puppetTitle").textContent = model.meta.name;
  document.querySelector("#puppetByline").textContent = model.meta.author
    ? `by ${model.meta.author}`
    : "anonymous puppet";
  rebuildControls();
  statusMessage(`${model.layers.length} layers loaded`, "good");
}

function animate(timeMs) {
  const time = timeMs / 1000;
  if (demo) {
    const yaw = Math.sin(time * 0.31) * 0.25 + Math.sin(time * 0.73 + 1.1) * 0.07;
    values["head.yaw"] = yaw;
    values["head.pitch"] = Math.sin(time * 0.23 + 0.8) * 0.07;
    values["head.roll"] = -yaw * 0.14 + Math.sin(time * 0.19) * 0.025;
    values["body.sway"] = Math.sin(time * 0.27 + 0.5) * 0.14;
    if ("body.breathe" in values) values["body.breathe"] = Math.sin(time * 1.12) * 0.48;
    values["eyes.lookX"] = Math.sin(time * 0.37) * 0.18;
    values["eyes.lookY"] = Math.sin(time * 0.29 + 0.4) * 0.08;
    if (time >= blinkAt && blinkStarted === null) blinkStarted = time;
    if (blinkStarted !== null) {
      const elapsed = time - blinkStarted;
      values["eyes.blink"] = elapsed < 0.18 ? Math.sin(elapsed / 0.18 * Math.PI) : 0;
      if (elapsed >= 0.18) {
        blinkStarted = null;
        blinkAt = time + 2.8 + Math.random() * 3.4;
      }
    }
    const target = -yaw * 0.34;
    const dt = 1 / 60;
    spring.velocity += (target - spring.position) * 11 * dt;
    spring.velocity *= Math.pow(0.84, dt * 60);
    spring.position += spring.velocity;
    values["hair.motion"] = Math.max(-1, Math.min(1, spring.position));
    const speech = Math.max(0, Math.sin(time * 0.52 + 0.4)) ** 1.8;
    values["mouth.open"] = microphoneLevel === null
      ? speech * (0.12 + (Math.sin(time * 8.1) * 0.5 + 0.5) * 0.25)
      : microphoneLevel;
    values["mouth.form"] = Math.sin(time * 2.1) * 0.1;
    if (Math.floor(timeMs / 120) !== Math.floor((timeMs - 16) / 120)) syncControls();
  }
  renderer.render(values);
  requestAnimationFrame(animate);
}

document.querySelector("#openModel").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  try {
    await setModel(parseModel(await fileInput.files[0].text()));
  } catch (error) {
    statusMessage(error.message, "bad");
  } finally {
    fileInput.value = "";
  }
});
document.querySelector("#demoMode").addEventListener("change", (event) => {
  demo = event.target.checked;
  if (!demo) microphoneLevel = null;
});
document.querySelector("#enableMic").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    audio.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const measure = () => {
      analyser.getByteTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        energy += centered * centered;
      }
      const rms = Math.sqrt(energy / samples.length);
      microphoneLevel = Math.max(0, Math.min(1, (rms - 0.015) * 9));
      requestAnimationFrame(measure);
    };
    measure();
    demo = true;
    document.querySelector("#demoMode").checked = true;
    document.querySelector("#enableMic").textContent = "Microphone active";
    document.querySelector("#enableMic").disabled = true;
    statusMessage("Microphone is driving Mouth Open", "good");
  } catch (error) {
    statusMessage(`Microphone unavailable: ${error.message}`, "bad");
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (!demo) return;
  const rect = canvas.getBoundingClientRect();
  values["eyes.lookX"] = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width - 0.5) * 2));
  values["eyes.lookY"] = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height - 0.5) * 2));
});

setModel(model).then(() => requestAnimationFrame(animate));
