import {
  clone,
  createLayer,
  defaultParameterValues,
  ensureKeyform,
  evaluateLayer,
  findKeyform,
  parseModel,
  removeKeyform,
  safeFilename,
  serializeModel,
  validateModel,
} from "./model.js";
import { KokoroRenderer } from "./renderer.js";
import { createSampleModel } from "./sample.js";
import { autoRigFile } from "./auto-rigger.js";

const AUTOSAVE_KEY = "kokoro2d-maker-autosave-v1";
const canvas = document.querySelector("#makerCanvas");
const overlay = document.querySelector("#meshOverlay");
const renderer = new KokoroRenderer(canvas);
const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
);

const state = {
  model: null,
  selectedLayerId: null,
  selectedParameterId: "head.yaw",
  values: {},
  autoplay: false,
  history: [],
  future: [],
  drag: null,
  dirty: false,
};

function setStatus(message, tone = "neutral") {
  elements.statusText.textContent = message;
  elements.statusText.dataset.tone = tone;
}

function selectedLayer() {
  return state.model.layers.find((layer) => layer.id === state.selectedLayerId) ?? null;
}

function selectedParameter() {
  return state.model.parameters[state.selectedParameterId];
}

function activeKeyform(layer = selectedLayer()) {
  if (!layer) return null;
  return findKeyform(layer, state.selectedParameterId, state.values[state.selectedParameterId]);
}

function snapshot() {
  return JSON.stringify({ model: state.model, selectedLayerId: state.selectedLayerId });
}

function checkpoint() {
  state.history.push(snapshot());
  if (state.history.length > 80) state.history.shift();
  state.future.length = 0;
}

async function restore(serialized) {
  const saved = JSON.parse(serialized);
  state.model = saved.model;
  state.selectedLayerId = saved.selectedLayerId;
  state.values = defaultParameterValues(state.model);
  await renderer.setModel(state.model);
  refreshAll();
  changed();
}

function changed(message = "Changes autosaved locally") {
  state.dirty = true;
  state.model.meta.modifiedAt = new Date().toISOString();
  localStorage.setItem(AUTOSAVE_KEY, snapshot());
  setStatus(message, "good");
  refreshInspector();
}

async function loadModel(model, message = "Model loaded") {
  const errors = validateModel(model);
  if (errors.length) throw new Error(errors.join("\n"));
  state.model = model;
  state.values = defaultParameterValues(model);
  state.selectedLayerId = model.layers.at(-1)?.id ?? null;
  state.history.length = 0;
  state.future.length = 0;
  await renderer.setModel(model);
  refreshAll();
  localStorage.setItem(AUTOSAVE_KEY, snapshot());
  setStatus(message, "good");
}

function refreshAll() {
  elements.modelName.value = state.model.meta.name;
  elements.modelAuthor.value = state.model.meta.author ?? "";
  refreshLayerList();
  refreshParameterList();
  refreshInspector();
}

function refreshLayerList() {
  elements.layerList.replaceChildren();
  const layers = [...state.model.layers].sort((a, b) => b.zIndex - a.zIndex);
  for (const layer of layers) {
    const button = document.createElement("button");
    button.className = `layer-row${layer.id === state.selectedLayerId ? " active" : ""}`;
    button.type = "button";
    button.innerHTML = `<span class="visibility">${layer.visible ? "◉" : "○"}</span><span>${escapeHtml(layer.name)}</span><small>z${layer.zIndex}</small>`;
    button.addEventListener("click", () => {
      state.selectedLayerId = layer.id;
      refreshLayerList();
      refreshInspector();
    });
    button.addEventListener("dblclick", () => {
      checkpoint();
      layer.visible = !layer.visible;
      changed(`${layer.visible ? "Showing" : "Hiding"} ${layer.name}`);
      refreshLayerList();
    });
    elements.layerList.append(button);
  }
  elements.emptyLayers.hidden = state.model.layers.length > 0;
}

function refreshParameterList() {
  elements.parameterSelect.replaceChildren();
  for (const parameter of Object.values(state.model.parameters)) {
    const option = document.createElement("option");
    option.value = parameter.id;
    option.textContent = parameter.name;
    option.selected = parameter.id === state.selectedParameterId;
    elements.parameterSelect.append(option);
  }
  const parameter = selectedParameter();
  elements.parameterValue.min = parameter.min;
  elements.parameterValue.max = parameter.max;
  elements.parameterValue.step = (parameter.max - parameter.min) / 100;
  elements.parameterValue.value = state.values[parameter.id];
  elements.parameterNumber.value = formatNumber(state.values[parameter.id]);
}

function refreshInspector() {
  const layer = selectedLayer();
  elements.noSelection.hidden = Boolean(layer);
  elements.layerInspector.hidden = !layer;
  if (!layer) return;

  const pose = evaluateLayer(layer, state.values, state.model.parameters);
  elements.layerName.value = layer.name;
  elements.layerVisible.checked = layer.visible;
  elements.layerX.value = formatNumber(pose.transform.x);
  elements.layerY.value = formatNumber(pose.transform.y);
  elements.layerRotation.value = formatNumber(pose.transform.rotation * 180 / Math.PI);
  elements.layerScaleX.value = formatNumber(pose.transform.scaleX);
  elements.layerScaleY.value = formatNumber(pose.transform.scaleY);
  elements.layerOpacity.value = formatNumber(pose.transform.opacity);
  const key = activeKeyform(layer);
  const parameter = selectedParameter();
  const atDefault = Math.abs(state.values[parameter.id] - parameter.default) < 1e-6;
  elements.keyformBadge.textContent = key ? "Editing keyform" : atDefault ? "Editing base mesh" : "Preview only";
  elements.keyformBadge.dataset.active = key ? "true" : "false";
  elements.createKeyform.disabled = atDefault || Boolean(key);
  elements.deleteKeyform.disabled = !key;
  const canEditPose = atDefault || Boolean(key);
  for (const input of elements.layerInspector.querySelectorAll("input[type='number']")) {
    input.disabled = !canEditPose;
  }
  elements.vertexHint.textContent = key
    ? "Drag mesh points to sculpt this keyform."
    : atDefault
      ? "Drag mesh points to edit the base mesh."
      : "Create a keyform before sculpting at this value.";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  })[character]);
}

function formatNumber(value) {
  return Number(value).toFixed(3).replace(/\.000$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function setOnlySelectedParameter(value) {
  for (const parameter of Object.values(state.model.parameters)) {
    state.values[parameter.id] = parameter.default;
  }
  state.values[state.selectedParameterId] = Number(value);
  elements.parameterValue.value = value;
  elements.parameterNumber.value = formatNumber(value);
  refreshInspector();
}

function applyTransform(property, value) {
  const layer = selectedLayer();
  if (!layer || !Number.isFinite(value)) return;
  const parameter = selectedParameter();
  const atDefault = Math.abs(state.values[parameter.id] - parameter.default) < 1e-6;
  if (!atDefault && !activeKeyform(layer)) {
    setStatus("Create a keyform before editing this pose", "bad");
    refreshInspector();
    return;
  }
  checkpoint();
  const key = activeKeyform(layer);
  if (key) key.transform[property] = value - layer.transform[property];
  else layer.transform[property] = value;
  changed();
}

async function downloadModel() {
  try {
    const portableModel = clone(state.model);
    await Promise.all(portableModel.layers.map(async (layer) => {
      if (layer.source.src.startsWith("data:")) return;
      const response = await fetch(layer.source.src);
      if (!response.ok) throw new Error(`Unable to embed ${layer.name}.`);
      layer.source.src = await readAsDataUrl(await response.blob());
      layer.source.type = "embedded";
    }));
    const contents = serializeModel(portableModel);
    const blob = new Blob([contents], { type: "application/vnd.kokoro2d+json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${safeFilename(state.model.meta.name)}.kokoro2d`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    state.dirty = false;
    setStatus(`Exported ${link.download}`, "good");
  } catch (error) {
    setStatus(`Export failed: ${error.message}`, "bad");
  }
}

async function importFiles(files) {
  const images = [...files].filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;
  checkpoint();
  for (const file of images) {
    const src = await readAsDataUrl(file);
    const dimensions = await imageDimensions(src);
    const maximum = 640;
    const factor = Math.min(1, maximum / Math.max(dimensions.width, dimensions.height));
    const layer = createLayer({
      name: file.name.replace(/\.[^.]+$/, ""),
      src,
      width: dimensions.width * factor,
      height: dimensions.height * factor,
      columns: 5,
      rows: 5,
      zIndex: state.model.layers.length,
    });
    state.model.layers.push(layer);
    state.selectedLayerId = layer.id;
  }
  await renderer.setModel(state.model);
  refreshAll();
  changed(`Imported ${images.length} layer${images.length === 1 ? "" : "s"}`);
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function imageDimensions(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = src;
  });
}

function drawOverlay() {
  const layer = selectedLayer();
  const context = overlay.getContext("2d");
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = overlay.clientWidth;
  const height = overlay.clientHeight;
  if (overlay.width !== width * ratio || overlay.height !== height * ratio) {
    overlay.width = width * ratio;
    overlay.height = height * ratio;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!layer || state.autoplay) return;
  const pose = evaluateLayer(layer, state.values, state.model.parameters);
  const points = [];
  for (let index = 0; index < pose.vertices.length; index += 2) {
    const world = renderer.localToWorld(pose.vertices[index], pose.vertices[index + 1], pose.transform);
    points.push(renderer.worldToScreen(world.x, world.y));
  }
  context.strokeStyle = "rgba(255, 166, 224, .34)";
  context.lineWidth = 1;
  for (let index = 0; index < layer.mesh.indices.length; index += 3) {
    const a = points[layer.mesh.indices[index]];
    const b = points[layer.mesh.indices[index + 1]];
    const c = points[layer.mesh.indices[index + 2]];
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.lineTo(c.x, c.y);
    context.closePath();
    context.stroke();
  }
  points.forEach((point, index) => {
    context.beginPath();
    context.arc(point.x, point.y, state.drag?.vertexIndex === index ? 6 : 4, 0, Math.PI * 2);
    context.fillStyle = state.drag?.vertexIndex === index ? "#fff" : "#ff8ed8";
    context.fill();
  });
}

function nearestVertex(clientX, clientY) {
  const layer = selectedLayer();
  if (!layer) return null;
  const rect = overlay.getBoundingClientRect();
  const pointer = { x: clientX - rect.left, y: clientY - rect.top };
  const pose = evaluateLayer(layer, state.values, state.model.parameters);
  let best = null;
  for (let index = 0; index < pose.vertices.length; index += 2) {
    const world = renderer.localToWorld(pose.vertices[index], pose.vertices[index + 1], pose.transform);
    const screen = renderer.worldToScreen(world.x, world.y);
    const distance = Math.hypot(screen.x - pointer.x, screen.y - pointer.y);
    if (distance <= 12 && (!best || distance < best.distance)) {
      best = { vertexIndex: index / 2, distance, pose };
    }
  }
  return best;
}

function animate(timeMs) {
  if (state.model) {
    if (state.autoplay) {
      const time = timeMs / 1000;
      const yaw = Math.sin(time * 0.31) * 0.25 + Math.sin(time * 0.73 + 1.1) * 0.07;
      const speech = Math.max(0, Math.sin(time * 0.52 + 0.4)) ** 1.8;
      state.values["head.yaw"] = yaw;
      state.values["head.pitch"] = Math.sin(time * 0.23 + 0.8) * 0.07;
      state.values["head.roll"] = -yaw * 0.14 + Math.sin(time * 0.19) * 0.025;
      state.values["body.sway"] = Math.sin(time * 0.27 + 0.5) * 0.14;
      state.values["body.breathe"] = Math.sin(time * 1.12) * 0.48;
      state.values["hair.motion"] = -yaw * 0.34 + Math.sin(time * 0.43 - 0.7) * 0.08;
      state.values["eyes.lookX"] = Math.sin(time * 0.37) * 0.18;
      state.values["eyes.lookY"] = Math.sin(time * 0.29 + 0.4) * 0.08;
      state.values["mouth.open"] = speech * (0.12 + (Math.sin(time * 8.1) * 0.5 + 0.5) * 0.25);
      state.values["mouth.form"] = Math.sin(time * 2.1) * 0.1;
      const blinkPhase = time % 4.3;
      state.values["eyes.blink"] = blinkPhase > 4.12 ? Math.sin((blinkPhase - 4.12) / 0.18 * Math.PI) : 0;
    }
    renderer.render(state.values);
    drawOverlay();
  }
  requestAnimationFrame(animate);
}

elements.parameterSelect.addEventListener("change", () => {
  state.selectedParameterId = elements.parameterSelect.value;
  setOnlySelectedParameter(selectedParameter().default);
  refreshParameterList();
});
elements.parameterValue.addEventListener("input", () => setOnlySelectedParameter(elements.parameterValue.value));
elements.parameterNumber.addEventListener("change", () => {
  const parameter = selectedParameter();
  const value = Math.max(parameter.min, Math.min(parameter.max, Number(elements.parameterNumber.value)));
  setOnlySelectedParameter(value);
});

elements.createKeyform.addEventListener("click", () => {
  const layer = selectedLayer();
  if (!layer) return;
  checkpoint();
  ensureKeyform(layer, state.selectedParameterId, state.values[state.selectedParameterId]);
  changed("Keyform created—sculpt away!");
});
elements.deleteKeyform.addEventListener("click", () => {
  const layer = selectedLayer();
  if (!layer) return;
  checkpoint();
  removeKeyform(layer, state.selectedParameterId, state.values[state.selectedParameterId]);
  changed("Keyform removed");
});

for (const [id, property, convert] of [
  ["layerX", "x", Number],
  ["layerY", "y", Number],
  ["layerRotation", "rotation", (value) => Number(value) * Math.PI / 180],
  ["layerScaleX", "scaleX", Number],
  ["layerScaleY", "scaleY", Number],
  ["layerOpacity", "opacity", Number],
]) {
  elements[id].addEventListener("change", () => applyTransform(property, convert(elements[id].value)));
}
elements.layerName.addEventListener("change", () => {
  const layer = selectedLayer();
  if (!layer) return;
  checkpoint();
  layer.name = elements.layerName.value.trim() || "Layer";
  refreshLayerList();
  changed();
});
elements.layerVisible.addEventListener("change", () => {
  const layer = selectedLayer();
  if (!layer) return;
  checkpoint();
  layer.visible = elements.layerVisible.checked;
  refreshLayerList();
  changed();
});

elements.addLayers.addEventListener("click", () => elements.layerFiles.click());
elements.layerFiles.addEventListener("change", async () => {
  await importFiles(elements.layerFiles.files);
  elements.layerFiles.value = "";
});
elements.deleteLayer.addEventListener("click", async () => {
  const layer = selectedLayer();
  if (!layer) return;
  checkpoint();
  state.model.layers = state.model.layers.filter((candidate) => candidate.id !== layer.id);
  state.model.layers.forEach((candidate, index) => { candidate.zIndex = index; });
  state.selectedLayerId = state.model.layers.at(-1)?.id ?? null;
  await renderer.setModel(state.model);
  refreshAll();
  changed(`Deleted ${layer.name}`);
});
for (const [id, direction] of [["layerUp", 1], ["layerDown", -1]]) {
  elements[id].addEventListener("click", () => {
    const layer = selectedLayer();
    if (!layer) return;
    checkpoint();
    const sorted = [...state.model.layers].sort((a, b) => a.zIndex - b.zIndex);
    const index = sorted.indexOf(layer);
    const target = Math.max(0, Math.min(sorted.length - 1, index + direction));
    [sorted[index], sorted[target]] = [sorted[target], sorted[index]];
    sorted.forEach((candidate, order) => { candidate.zIndex = order; });
    refreshLayerList();
    changed();
  });
}

elements.modelName.addEventListener("change", () => {
  checkpoint();
  state.model.meta.name = elements.modelName.value.trim() || "Untitled Puppet";
  changed();
});
elements.modelAuthor.addEventListener("change", () => {
  checkpoint();
  state.model.meta.author = elements.modelAuthor.value.trim();
  changed();
});
elements.exportModel.addEventListener("click", downloadModel);
elements.importModel.addEventListener("click", () => elements.modelFile.click());
elements.modelFile.addEventListener("change", async () => {
  try {
    const model = parseModel(await elements.modelFile.files[0].text());
    await loadModel(model, "Kokoro2D model imported");
  } catch (error) {
    setStatus(error.message, "bad");
  } finally {
    elements.modelFile.value = "";
  }
});

let autoRigPreviewUrl = null;

function updateAutoRigProgress(message, progress) {
  elements.autoRigProgress.hidden = false;
  elements.autoRigProgressText.textContent = message;
  elements.autoRigProgressBar.style.width = `${Math.round(progress * 100)}%`;
}

async function runAutoRig(file) {
  if (!file) return;
  if (state.dirty && !confirm("Replace the current model with this auto-rig? Your autosave will be replaced.")) return;
  if (autoRigPreviewUrl) URL.revokeObjectURL(autoRigPreviewUrl);
  autoRigPreviewUrl = URL.createObjectURL(file);
  elements.autoRigPreview.src = autoRigPreviewUrl;
  elements.autoRigPreview.hidden = false;
  elements.autoRigDropCopy.hidden = true;
  elements.autoRigReport.hidden = true;
  elements.autoRigWarnings.replaceChildren();
  elements.autoRigInput.disabled = true;
  updateAutoRigProgress("Waking up the pixel goblins", 0.02);

  try {
    const { model, report } = await autoRigFile(file, { onProgress: updateAutoRigProgress });
    await loadModel(model, `Auto-rigged ${model.meta.name}`);
    state.dirty = true;
    elements.autoRigConfidence.textContent = `${Math.round(report.confidence * 100)}%`;
    elements.autoRigResultTitle.textContent = `${model.meta.name} is alive`;
    elements.autoRigResultStats.textContent = `${report.sourceSize} source · ${report.meshVertices} mesh points · ${report.keyforms} authored keyforms · ${report.backgroundMode}`;
    const warnings = report.warnings.length
      ? report.warnings
      : ["No major uncertainty detected. Still inspect the blink and mouth because pixels are sneaky."];
    for (const warning of warnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      elements.autoRigWarnings.append(item);
    }
    elements.autoRigReport.hidden = false;
    setStatus(`Full auto-rig complete: ${Math.round(report.confidence * 100)}% confidence`, "good");
  } catch (error) {
    console.error(error);
    elements.autoRigResultTitle.textContent = "The ritual encountered a problem";
    elements.autoRigResultStats.textContent = error.message;
    elements.autoRigConfidence.textContent = "×";
    elements.autoRigReport.hidden = false;
    setStatus(`Auto-rig failed: ${error.message}`, "bad");
  } finally {
    elements.autoRigInput.disabled = false;
  }
}

elements.autoRigButton.addEventListener("click", () => {
  elements.autoRigDialog.showModal();
});
elements.autoRigInput.addEventListener("change", async () => {
  await runAutoRig(elements.autoRigInput.files[0]);
  elements.autoRigInput.value = "";
});
for (const eventName of ["dragenter", "dragover"]) {
  elements.autoRigDrop.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.autoRigDrop.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.autoRigDrop.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.autoRigDrop.classList.remove("dragging");
  });
}
elements.autoRigDrop.addEventListener("drop", async (event) => {
  await runAutoRig([...event.dataTransfer.files].find((file) => file.type.startsWith("image/")));
});
elements.autoRigDialog.addEventListener("close", () => {
  if (autoRigPreviewUrl) URL.revokeObjectURL(autoRigPreviewUrl);
  autoRigPreviewUrl = null;
  elements.autoRigPreview.removeAttribute("src");
  elements.autoRigPreview.hidden = true;
  elements.autoRigDropCopy.hidden = false;
  elements.autoRigProgress.hidden = true;
  elements.autoRigReport.hidden = true;
});
elements.newSample.addEventListener("click", async () => {
  if (state.dirty && !confirm("Replace the current model with a fresh sample?")) return;
  await loadModel(createSampleModel(), "Fresh sample created");
});
elements.togglePreview.addEventListener("click", () => {
  state.autoplay = !state.autoplay;
  elements.togglePreview.classList.toggle("active", state.autoplay);
  elements.togglePreview.textContent = state.autoplay ? "Stop preview" : "Animate preview";
  if (!state.autoplay) {
    state.values = defaultParameterValues(state.model);
    refreshParameterList();
    refreshInspector();
  }
});

elements.undo.addEventListener("click", async () => {
  if (!state.history.length) return;
  state.future.push(snapshot());
  await restore(state.history.pop());
  setStatus("Undid last change");
});
elements.redo.addEventListener("click", async () => {
  if (!state.future.length) return;
  state.history.push(snapshot());
  await restore(state.future.pop());
  setStatus("Redid change");
});

overlay.addEventListener("pointerdown", (event) => {
  const layer = selectedLayer();
  const parameter = selectedParameter();
  const atDefault = Math.abs(state.values[parameter.id] - parameter.default) < 1e-6;
  if (!layer || (!atDefault && !activeKeyform(layer))) return;
  const nearest = nearestVertex(event.clientX, event.clientY);
  if (!nearest) return;
  checkpoint();
  state.drag = { vertexIndex: nearest.vertexIndex };
  overlay.setPointerCapture(event.pointerId);
});
overlay.addEventListener("pointermove", (event) => {
  if (!state.drag) return;
  const layer = selectedLayer();
  const rect = overlay.getBoundingClientRect();
  const world = renderer.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
  const pose = evaluateLayer(layer, state.values, state.model.parameters);
  const local = renderer.worldToLocal(world.x, world.y, pose.transform);
  const valueIndex = state.drag.vertexIndex * 2;
  const key = activeKeyform(layer);
  if (key) {
    key.offsets[valueIndex] = local.x - layer.mesh.vertices[valueIndex];
    key.offsets[valueIndex + 1] = local.y - layer.mesh.vertices[valueIndex + 1];
  } else {
    layer.mesh.vertices[valueIndex] = local.x;
    layer.mesh.vertices[valueIndex + 1] = local.y;
  }
  state.dirty = true;
});
overlay.addEventListener("pointerup", () => {
  if (!state.drag) return;
  state.drag = null;
  changed("Mesh updated");
});

document.addEventListener("keydown", async (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === "z") {
    event.preventDefault();
    (event.shiftKey ? elements.redo : elements.undo).click();
  }
  if (modifier && event.key.toLowerCase() === "s") {
    event.preventDefault();
    downloadModel();
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
});

async function boot() {
  try {
    const autosave = localStorage.getItem(AUTOSAVE_KEY);
    if (autosave) {
      const saved = JSON.parse(autosave);
      await loadModel(saved.model, "Recovered local autosave");
      state.selectedLayerId = saved.selectedLayerId;
      refreshAll();
    } else {
      await loadModel(createSampleModel(), "Sample puppet ready");
    }
  } catch (error) {
    console.error(error);
    localStorage.removeItem(AUTOSAVE_KEY);
    await loadModel(createSampleModel(), "Autosave was invalid; loaded sample");
  }
  state.dirty = false;
  requestAnimationFrame(animate);
}

boot();
