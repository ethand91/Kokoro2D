import { editArtwork } from "./art-editor.js";
import { importOpenRaster } from "./openraster.js";
import { importProject, exportProject, downloadBlob } from "./project-file.js";
import { projectStore, SnapshotPool } from "./project-store.js";
import { reviewRegions } from "./region-editor.js";
import { bindParent, evaluateScene, sceneToLayer } from "./scene.js";
import { PuppetMotion } from "./motion.js";
import {
  AUTOSAVE_KEY,
  clone,
  uid,
  ensureCorrective,
  createLayer,
  defaultParameterValues,
  ensureKeyform,
  evaluateLayer,
  findKeyform,
  removeKeyform,
  safeFilename,
  serializeModel,
  validateModel,
} from "./model.js";
import { KokoroRenderer } from "./renderer.js";
import { createLayeredSampleModel } from "./sample.js";
import { autoRigFile } from "./auto-rigger.js";

const motion = new PuppetMotion({ style: "energetic" });

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
  if (elements.combineParameters.checked) {
    return (layer.correctives ?? []).find(pose => Object.keys(pose.drivers).length === 2 && pose.drivers[state.selectedParameterId] === state.values[state.selectedParameterId] && pose.drivers[elements.secondParameter.value] === state.values[elements.secondParameter.value]) ?? null;
  }
  return findKeyform(layer, state.selectedParameterId, state.values[state.selectedParameterId]);
}

let snapshotPool = new SnapshotPool();
function snapshot() {
  return snapshotPool.pack({ model: state.model, selectedLayerId: state.selectedLayerId });
}
let saveGeneration = 0;
function persist() {
  const generation = ++saveGeneration;
  return projectStore.save({ model: state.model, selectedLayerId: state.selectedLayerId }).then(() => {
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ database: true, at: Date.now() })); } catch { /* IndexedDB remains the primary save. */ }
    return true;
  }).catch(error => { if(generation===saveGeneration)setStatus(`Autosave failed: ${error.message}. Export a project to keep your work.`,"bad"); return false; });
}

function checkpoint() {
  state.history.push(snapshot());
  if (state.history.length > 80) state.history.shift();
  state.future.length = 0;
}

async function restore(serialized) {
  const saved = snapshotPool.unpack(serialized);
  state.model = saved.model;
  state.selectedLayerId = saved.selectedLayerId;
  state.values = defaultParameterValues(state.model);
  await renderer.setModel(state.model);
  refreshAll();
  changed();
}

function changed(message = "Changes autosaved locally") {
  state.model.version = 3;
  state.dirty = true;
  state.model.meta.modifiedAt = new Date().toISOString();
  persist();
  setStatus(message, "good");
  refreshInspector();
}

async function loadModel(model, message = "Model loaded", { save = true } = {}) {
  const errors = validateModel(model);
  if (errors.length) throw new Error(errors.join("\n"));
  await renderer.setModel(model);
  state.model = model;
  state.values = defaultParameterValues(model);
  state.selectedLayerId = model.layers.at(-1)?.id ?? null;
  snapshotPool = new SnapshotPool();
  state.history.length = 0;
  state.future.length = 0;
  refreshAll();
  if (!save || await persist()) setStatus(message, save ? "good" : "bad");
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
  if (!state.model.parameters[state.selectedParameterId]) {
    state.selectedParameterId = Object.keys(state.model.parameters)[0];
  }
  elements.parameterSelect.replaceChildren();
  for (const parameter of Object.values(state.model.parameters)) {
    const option = document.createElement("option");
    option.value = parameter.id;
    option.textContent = parameter.name;
    option.selected = parameter.id === state.selectedParameterId;
    elements.parameterSelect.append(option);
  }
  const previous = elements.secondParameter.value;
  elements.secondParameter.replaceChildren();
  for (const parameter of Object.values(state.model.parameters)) if(parameter.id!==state.selectedParameterId) elements.secondParameter.add(new Option(parameter.name,parameter.id));
  elements.secondParameter.value = state.model.parameters[previous] && previous!==state.selectedParameterId ? previous : Object.keys(state.model.parameters).find(id=>id!==state.selectedParameterId);
  refreshSecondParameter();
  const parameter = selectedParameter();
  elements.parameterValue.min = parameter.min;
  elements.parameterValue.max = parameter.max;
  elements.parameterValue.step = (parameter.max - parameter.min) / 100;
  elements.parameterValue.value = state.values[parameter.id];
  elements.parameterNumber.value = formatNumber(state.values[parameter.id]);
}

function refreshSecondParameter() {
  const p = state.model.parameters[elements.secondParameter.value]; if(!p)return;
  elements.secondValue.min=p.min;elements.secondValue.max=p.max;elements.secondValue.value=state.values[p.id]??p.default;
  elements.secondValue.step=(p.max-p.min)/100;
}

function refreshInspector() {
  const layer = selectedLayer();
  elements.noSelection.hidden = Boolean(layer);
  elements.layerInspector.hidden = !layer;
  if (!layer) return;

  const pose = evaluateLayer(layer, state.values, state.model.parameters);
  for (const [select, value] of [[elements.layerParent, layer.parent?.id], [elements.layerMask, layer.clipMask]]) {
    select.replaceChildren(new Option("None", ""));
    for (const item of state.model.layers) if (item.id !== layer.id) select.add(new Option(item.name, item.id));
    select.value = value ?? "";
  }
  elements.layerBlend.value=layer.blendMode??"normal";
  elements.layerGroup.replaceChildren(new Option("None",""));
  for(const group of state.model.groups??[])elements.layerGroup.add(new Option(group.name,group.id));
  elements.layerGroup.value=layer.group??"";
  const group=state.model.groups?.find(g=>g.id===layer.group);
  elements.groupInspector.hidden=!group;
  if(group){
    elements.groupName.value=group.name;elements.groupOpacity.value=group.opacity??1;elements.groupVisible.checked=group.visible!==false;elements.groupBlend.value=group.blendMode??"normal";
    elements.groupParent.replaceChildren(new Option("None",""));for(const item of state.model.groups)if(item.id!==group.id)elements.groupParent.add(new Option(item.name,item.id));elements.groupParent.value=group.parent??"";
    elements.groupMask.replaceChildren(new Option("None",""));for(const item of state.model.layers)elements.groupMask.add(new Option(item.name,item.id));elements.groupMask.value=group.clipMask??"";
  }
  elements.layerMaskOnly.checked = Boolean(layer.maskOnly);
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
  const atDefault = !elements.combineParameters.checked && Math.abs(state.values[parameter.id] - parameter.default) < 1e-6;
  elements.keyformBadge.textContent = key ? "Editing keyform" : atDefault ? "Editing base mesh" : "Preview only";
  elements.keyformBadge.dataset.active = key ? "true" : "false";
  const second=state.model.parameters[elements.secondParameter.value];
  const invalidCombined=elements.combineParameters.checked && (state.values[parameter.id]===parameter.default || state.values[second.id]===second.default);
  elements.createKeyform.disabled = atDefault || Boolean(key) || invalidCombined;
  elements.deleteKeyform.disabled = !key;
  const canEditPose = atDefault || Boolean(key);
  for (const input of elements.layerInspector.querySelectorAll(".property-grid input[type='number']")) {
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
    if(elements.combineParameters.checked && parameter.id===elements.secondParameter.value)continue;
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
  const atDefault = !elements.combineParameters.checked && Math.abs(state.values[parameter.id] - parameter.default) < 1e-6;
  if (!atDefault && !activeKeyform(layer)) {
    setStatus("Create a keyform before editing this pose", "bad");
    refreshInspector();
    return;
  }
  checkpoint();
  const key = activeKeyform(layer);
  if (key) {
    const original=key.transform[property];key.transform[property]=0;
    const rest=evaluateLayer(layer,state.values,state.model.parameters).transform[property];
    key.transform[property]=Number.isFinite(rest)?value-rest:original;
  }
  else layer.transform[property] = value;
  changed();
}

async function downloadModel() {
  try {
    await projectStore.queue.catch(() => {});
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
  const pose = evaluateScene(state.model, state.values).get(layer.id);
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
  const pose = evaluateScene(state.model, state.values).get(layer.id);
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
    const pose = motion.update(timeMs, state.model, { active: state.autoplay });
    if (state.autoplay) Object.assign(state.values, pose);
    try { renderer.render(state.values); }
    catch (error) { setStatus(`Rendering interrupted: ${error.message}`, "bad"); }
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
  if(elements.combineParameters.checked)ensureCorrective(layer,{[state.selectedParameterId]:state.values[state.selectedParameterId],[elements.secondParameter.value]:state.values[elements.secondParameter.value]});
  else ensureKeyform(layer, state.selectedParameterId, state.values[state.selectedParameterId]);
  changed("Keyform created—sculpt away!");
});
elements.deleteKeyform.addEventListener("click", () => {
  const layer = selectedLayer();
  if (!layer) return;
  checkpoint();
  if(elements.combineParameters.checked)layer.correctives=layer.correctives.filter(pose=>pose!==activeKeyform(layer));
  else removeKeyform(layer, state.selectedParameterId, state.values[state.selectedParameterId]);
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

for (const [element, property] of [[elements.layerParent, 'parent'], [elements.layerMask, 'clipMask']]) {
  element.addEventListener('change', () => {
    const layer = selectedLayer();
    if (!layer) return;
    const previous = structuredClone(layer[property]);
    if (property === 'parent' && element.value) bindParent(layer, state.model.layers.find(item => item.id === element.value));
    else if (element.value) layer[property] = element.value;
    else delete layer[property];
    const errors = validateModel(state.model);
    if (errors.length) { if (previous === undefined) delete layer[property]; else layer[property] = previous; refreshInspector(); setStatus(errors.join(' '), 'bad'); return; }
    const next = structuredClone(layer[property]);
    if (previous === undefined) delete layer[property]; else layer[property] = previous;
    checkpoint();
    if (next === undefined) delete layer[property]; else layer[property] = next;
    changed('Layer relationship updated');
  });
}
elements.layerMaskOnly.addEventListener('change', () => {
  const layer = selectedLayer(); if (!layer) return;
  checkpoint(); layer.maskOnly = elements.layerMaskOnly.checked; changed('Layer display updated');
});

elements.addLayers.addEventListener("click", () => elements.layerFiles.click());
elements.layerFiles.addEventListener("change", async () => {
  await importFiles(elements.layerFiles.files);
  elements.layerFiles.value = "";
});
elements.deleteLayer.addEventListener("click", async () => {
  const layer = selectedLayer();
  if (!layer) return;
  if (state.model.layers.some(item => item.parent?.id === layer.id || item.clipMask === layer.id) || state.model.groups?.some(group => group.clipMask === layer.id)) {
    setStatus("Detach child layers and clipping masks before deleting this layer.", "bad");
    return;
  }
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
document.querySelector('a[href="./viewer.html"]').addEventListener("click",async event=>{if(event.metaKey||event.ctrlKey||event.shiftKey)return;event.preventDefault();await projectStore.queue.catch(()=>{});location.href="./viewer.html";});
elements.importModel.addEventListener("click", () => elements.modelFile.click());
elements.modelFile.addEventListener("change", async () => {
  try {
    const file=elements.modelFile.files[0];if(!file)return;
    const model = /\.ora$/i.test(file.name) ? await importOpenRaster(file) : await importProject(file);
    await loadModel(model, "Kokoro2D model imported");
  } catch (error) {
    setStatus(error.message, "bad");
  } finally {
    elements.modelFile.value = "";
  }
});

elements.exportArchive.onclick=async()=>{
  try{downloadBlob(await exportProject(state.model),`${safeFilename(state.model.meta.name)}.kokoro2d.zip`);state.dirty=false;setStatus("Project ZIP exported","good");}
  catch(error){setStatus(error.message,"bad");}
};
elements.recoverProject.onclick=async()=>{
  try {
    const revisions=await projectStore.revisions();
    const dialog=document.createElement("dialog");dialog.className="recovery-dialog";
    const panel=document.createElement("div");panel.className="dialog-card";panel.innerHTML="<h2>Recovery history</h2><p>Restore a saved revision. Your current project stays in recovery history.</p>";
    for(const revision of revisions){const button=document.createElement("button");button.type="button";button.textContent=`${revision.name} — ${new Date(revision.at).toLocaleString()}`;button.onclick=async()=>{try{const saved=await projectStore.load(revision);await loadModel(saved.model,"Recovered saved revision");dialog.close();}catch(error){setStatus(error.message,"bad");}};panel.append(button);}
    const close=document.createElement("button");close.textContent="Close";close.onclick=()=>dialog.close();panel.append(close);dialog.append(panel);document.body.append(dialog);dialog.onclose=()=>dialog.remove();dialog.showModal();
  }catch(error){setStatus(error.message,"bad");}
};
elements.combineParameters.onchange=()=>{refreshSecondParameter();refreshInspector();};
elements.secondParameter.onchange=()=>{refreshSecondParameter();refreshInspector();};
elements.secondValue.oninput=()=>{state.values[elements.secondParameter.value]=Number(elements.secondValue.value);refreshInspector();};
elements.editArtwork.onclick=async()=>{
  const layer=selectedLayer();if(!layer)return;
  try{const artwork=await editArtwork(layer);if(!artwork)return;checkpoint();layer.source={...layer.source,src:artwork.src,type:"embedded"};delete layer.source.crop;await renderer.setModel(state.model);changed("Artwork updated");}
  catch(error){setStatus(error.message,"bad");}
};
for(const [id,property] of [["layerBlend","blendMode"],["layerGroup","group"]])elements[id].onchange=()=>{const layer=selectedLayer();if(!layer)return;checkpoint();layer[property]=elements[id].value||null;changed();};
elements.createGroup.onclick=()=>{const layer=selectedLayer();if(!layer)return;checkpoint();state.model.groups??=[];const group={id:uid("group"),name:"New group",parent:layer.group??null,zIndex:layer.zIndex,opacity:1,visible:true,blendMode:"normal"};state.model.groups.push(group);layer.group=group.id;changed("Isolated group created");elements.groupInspector.open=true;};
for(const [id,property,convert] of [["groupName","name",v=>v||"Group"],["groupOpacity","opacity",v=>Math.max(0,Math.min(1,Number(v)))],["groupVisible","visible",()=>elements.groupVisible.checked],["groupBlend","blendMode",v=>v],["groupParent","parent",v=>v||null],["groupMask","clipMask",v=>v||null]])elements[id].onchange=()=>{
  const group=state.model.groups?.find(g=>g.id===selectedLayer()?.group);if(!group)return;const old=group[property],next=convert(elements[id].value);if(Object.is(old,next))return;group[property]=next;
  const errors=validateModel(state.model);group[property]=old;if(errors.length){refreshInspector();setStatus(errors.join(" "),"bad");return;}checkpoint();group[property]=next;changed("Group updated");
};
elements.dissolveGroup.onclick=()=>{const group=state.model.groups?.find(g=>g.id===selectedLayer()?.group);if(!group)return;checkpoint();for(const layer of state.model.layers)if(layer.group===group.id)layer.group=group.parent;for(const child of state.model.groups)if(child.parent===group.id)child.parent=group.parent;state.model.groups=state.model.groups.filter(g=>g!==group);changed("Group dissolved");};

let autoRigPreviewUrl = null;

function updateAutoRigProgress(message, progress) {
  elements.autoRigProgress.hidden = false;
  elements.autoRigProgressText.textContent = message;
  elements.autoRigProgressBar.style.width = `${Math.round(progress * 100)}%`;
}

async function runAutoRig(file) {
  if (!file || elements.autoRigInput.disabled) return;
  if (state.dirty && !confirm("Replace the current model with this auto-rig? Your autosave will be replaced.")) return;
  if (autoRigPreviewUrl) URL.revokeObjectURL(autoRigPreviewUrl);
  autoRigPreviewUrl = URL.createObjectURL(file);
  elements.autoRigPreview.src = autoRigPreviewUrl;
  elements.autoRigPreview.hidden = false;
  elements.autoRigDropCopy.hidden = true;
  elements.autoRigReport.hidden = true;
  elements.autoRigWarnings.replaceChildren();
  const faceOnly = elements.autoRigFaceOnly.checked;
  elements.autoRigFaceOnly.disabled = true;
  elements.autoRigInput.disabled = true;
  updateAutoRigProgress("Waking up the pixel goblins", 0.02);
  const controller = new AbortController();
  const abort = () => controller.abort();
  elements.autoRigDialog.addEventListener('close', abort, { once: true });

  try {
    const { model, report } = await autoRigFile(file, { faceOnly, signal: controller.signal, onProgress: updateAutoRigProgress, review: prepared => reviewRegions(elements.autoRigDialog, prepared) });
    await loadModel(model, `Auto-rigged ${model.meta.name}`);
    state.dirty = true;
    elements.autoRigConfidence.textContent = `${Math.round(report.confidence * 100)}%`;
    elements.autoRigResultTitle.textContent = `${model.meta.name} is alive`;
    elements.autoRigResultStats.textContent = `${report.sourceSize} source · ${report.meshVertices} mesh points · ${report.keyforms} authored keyforms · ${report.backgroundMode} · ${report.landmarkMethod}`;
    const warnings = report.warnings.length
      ? report.warnings
      : ["No major uncertainty detected. Still inspect the blink and mouth because pixels are sneaky."];
    for (const warning of warnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      elements.autoRigWarnings.append(item);
    }
    elements.autoRigReport.hidden = false;
    setStatus(`${faceOnly ? 'Blink and talking rig' : 'Full auto-rig'} complete: ${Math.round(report.confidence * 100)}% confidence`, "good");
  } catch (error) {
    if (controller.signal.aborted || error.message === 'Rig creation cancelled.') {
      setStatus('Rig creation cancelled; current model kept');
      return;
    }
    console.error(error);
    elements.autoRigResultTitle.textContent = "The ritual encountered a problem";
    elements.autoRigResultStats.textContent = error.message;
    elements.autoRigConfidence.textContent = "×";
    elements.autoRigReport.hidden = false;
    setStatus(`Auto-rig failed: ${error.message}`, "bad");
  } finally {
    elements.autoRigDialog.removeEventListener("close", abort);
    elements.autoRigInput.disabled = false;
    elements.autoRigFaceOnly.disabled = false;
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
  await loadModel(await createLayeredSampleModel(), "Fresh sample created");
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
  const atDefault = !elements.combineParameters.checked && Math.abs(state.values[parameter.id] - parameter.default) < 1e-6;
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
  const [localX, localY] = sceneToLayer(layer, world.x, world.y, state.model, state.values);
  const local = { x: localX, y: localY };
  const valueIndex = state.drag.vertexIndex * 2;
  const key = activeKeyform(layer);
  if (key) {
    key.offsets[valueIndex]=0;key.offsets[valueIndex+1]=0;
    const rest=evaluateLayer(layer,state.values,state.model.parameters).vertices;
    key.offsets[valueIndex]=local.x-rest[valueIndex];key.offsets[valueIndex+1]=local.y-rest[valueIndex+1];
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
    const saved = await projectStore.load();
    if (saved) {
      await loadModel(saved.model, "Recovered local autosave");
      state.selectedLayerId = saved.selectedLayerId;
      refreshAll();
    } else {
      await loadModel(await createLayeredSampleModel(), "Sample puppet ready");
    }
  } catch (error) {
    console.error(error);
    await loadModel(await createLayeredSampleModel(), `Could not restore autosave: ${error.message}. Sample loaded; stored work kept. Use Recover project or export your work.`, { save: false });
  }
  state.dirty = false;
  requestAnimationFrame(animate);
}

boot();

renderer.addEventListener("contextlost", () => setStatus("Graphics context lost; waiting for recovery.", "bad"));
renderer.addEventListener("contextrestored", () => setStatus("Graphics recovered · current rig restored", "good"));
renderer.addEventListener("recoveryerror", event => setStatus(`Graphics recovery failed: ${event.detail.message}. Reload to retry.`, "bad"));
window.addEventListener("pagehide", event => { if (!event.persisted) renderer.dispose(); });
