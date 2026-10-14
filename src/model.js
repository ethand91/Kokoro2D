import { validateModel } from "./model-validation.js";
import { parseJson, MODEL_LIMITS } from "./import-limits.js";
export { validateModel, MODEL_LIMITS };

export const SCHEMA = "kokoro2d";

// Where the Maker parks the puppet you are working on. The Viewer reads it so
// that opening the Viewer shows what you just rigged rather than the sample.
export const AUTOSAVE_KEY = "kokoro2d-maker-autosave-v1";
export const SCHEMA_VERSION = 3;

export const STANDARD_PARAMETERS = Object.freeze([
  { id: "head.yaw", name: "Head Yaw", min: -1, max: 1, default: 0 },
  { id: "head.pitch", name: "Head Pitch", min: -1, max: 1, default: 0 },
  { id: "head.roll", name: "Head Roll", min: -1, max: 1, default: 0 },
  { id: "eyes.blink", name: "Eye Blink", min: 0, max: 1, default: 0 },
  { id: "eyes.blinkLeft", name: "Left Blink / Wink", min: 0, max: 1, default: 0 },
  { id: "eyes.blinkRight", name: "Right Blink / Wink", min: 0, max: 1, default: 0 },
  { id: "eyes.squint", name: "Squint", min: 0, max: 1, default: 0 },
  { id: "brows.raise", name: "Brow Raise", min: -1, max: 1, default: 0 },
  { id: "mouth.smile", name: "Mouth Corners", min: -1, max: 1, default: 0 },
  { id: "mouth.jaw", name: "Jaw", min: 0, max: 1, default: 0 },
  { id: "eyes.lookX", name: "Eye Look X", min: -1, max: 1, default: 0 },
  { id: "eyes.lookY", name: "Eye Look Y", min: -1, max: 1, default: 0 },
  { id: "mouth.open", name: "Mouth Open", min: 0, max: 1, default: 0 },
  { id: "mouth.form", name: "Mouth Form", min: -1, max: 1, default: 0 },
  { id: "body.sway", name: "Body Sway", min: -1, max: 1, default: 0 },
  { id: "hair.motion", name: "Hair Motion", min: -1, max: 1, default: 0 },
]);

export function uid(prefix = "item") {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}_${random}`;
}

export function clone(value) {
  return structuredClone(value);
}

export function createModel(name = "Untitled Puppet") {
  return {
    schema: SCHEMA,
    version: SCHEMA_VERSION,
    meta: {
      id: uid("puppet"),
      name,
      author: "",
      license: "All rights reserved",
      createdAt: new Date().toISOString(),
      generator: "Kokoro2D Maker 0.2.0",
    },
    canvas: { width: 1000, height: 1000, background: "#24172f" },
    parameters: Object.fromEntries(STANDARD_PARAMETERS.map((parameter) => [
      parameter.id,
      { ...parameter },
    ])),
    physics: [
      {
        id: "hair-sway",
        input: "head.yaw",
        output: "hair.motion",
        strength: -0.55,
        frequency: 3.2,
        damping: 0.72,
      },
    ],
    groups: [],
    layers: [],
  };
}

export function createGridMesh(width, height, columns = 4, rows = 4) {
  const cols = Math.max(1, Math.round(columns));
  const rowCount = Math.max(1, Math.round(rows));
  const vertices = [];
  const uvs = [];
  const indices = [];

  for (let y = 0; y <= rowCount; y += 1) {
    for (let x = 0; x <= cols; x += 1) {
      const u = x / cols;
      const v = y / rowCount;
      vertices.push((u - 0.5) * width, (v - 0.5) * height);
      uvs.push(u, v);
    }
  }

  for (let y = 0; y < rowCount; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const topLeft = y * (cols + 1) + x;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + cols + 1;
      const bottomRight = bottomLeft + 1;
      indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
    }
  }

  return { columns: cols, rows: rowCount, vertices, uvs, indices };
}

export function createLayer({
  name,
  src,
  width,
  height,
  columns = 4,
  rows = 4,
  x = 0,
  y = 0,
  zIndex = 0,
}) {
  return {
    id: uid("layer"),
    name,
    visible: true,
    zIndex,
    source: { type: "embedded", src, width, height },
    transform: { x, y, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 },
    mesh: createGridMesh(width, height, columns, rows),
    keyforms: {},
  };
}

function zeroPose(vertexValueCount) {
  return {
    transform: { x: 0, y: 0, rotation: 0, scaleX: 0, scaleY: 0, opacity: 0 },
    offsets: Array(vertexValueCount).fill(0),
  };
}

export function ensureKeyform(layer, parameterId, value) {
  const channel = layer.keyforms[parameterId] ?? (layer.keyforms[parameterId] = []);
  let keyform = channel.find((key) => Math.abs(key.value - value) < 1e-6);
  if (!keyform) {
    keyform = { value, ...zeroPose(layer.mesh.vertices.length) };
    channel.push(keyform);
    channel.sort((a, b) => a.value - b.value);
  }
  return keyform;
}

export function findKeyform(layer, parameterId, value) {
  return (layer.keyforms[parameterId] ?? []).find(
    (key) => Math.abs(key.value - value) < 1e-6,
  ) ?? null;
}

export function removeKeyform(layer, parameterId, value) {
  const channel = layer.keyforms[parameterId];
  if (!channel) return false;
  const next = channel.filter((key) => Math.abs(key.value - value) >= 1e-6);
  if (next.length === channel.length) return false;
  if (next.length) layer.keyforms[parameterId] = next;
  else delete layer.keyforms[parameterId];
  return true;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function interpolateKeyforms(keyforms, value, defaultValue, vertexValueCount) {
  if (!keyforms?.length) return zeroPose(vertexValueCount);
  const keys = [...keyforms];
  if (!keys.some((key) => Math.abs(key.value - defaultValue) < 1e-6)) {
    keys.push({ value: defaultValue, ...zeroPose(vertexValueCount) });
  }
  keys.sort((a, b) => a.value - b.value);

  let left = keys[0];
  let right = keys[keys.length - 1];
  for (let index = 0; index < keys.length - 1; index += 1) {
    if (value >= keys[index].value && value <= keys[index + 1].value) {
      left = keys[index];
      right = keys[index + 1];
      break;
    }
  }
  if (value <= keys[0].value) left = right = keys[0];
  if (value >= keys[keys.length - 1].value) left = right = keys[keys.length - 1];
  const span = right.value - left.value;
  const linearAmount = span === 0 ? 0 : (value - left.value) / span;
  const amount = linearAmount * linearAmount * (3 - 2 * linearAmount);
  const result = zeroPose(vertexValueCount);

  for (const property of Object.keys(result.transform)) {
    result.transform[property] = lerp(
      left.transform?.[property] ?? 0,
      right.transform?.[property] ?? 0,
      amount,
    );
  }
  for (let index = 0; index < vertexValueCount; index += 1) {
    result.offsets[index] = lerp(
      left.offsets?.[index] ?? 0,
      right.offsets?.[index] ?? 0,
      amount,
    );
  }
  return result;
}

export function ensureCorrective(layer, drivers) {
  const signature = JSON.stringify(Object.entries(drivers).sort());
  const correctives = layer.correctives ?? (layer.correctives = []);
  let pose = correctives.find(item => JSON.stringify(Object.entries(item.drivers).sort()) === signature);
  if (!pose) { pose = { drivers: { ...drivers }, ...zeroPose(layer.mesh.vertices.length) }; correctives.push(pose); }
  return pose;
}

export function correctiveWeight(drivers, parameters, definitions) {
  return Object.entries(drivers).reduce((weight, [id, target]) => {
    const base = definitions[id]?.default ?? 0, span = target - base;
    const t = span ? Math.max(0, Math.min(1, ((parameters[id] ?? base) - base) / span)) : 0;
    return weight * t * t * (3 - 2 * t);
  }, 1);
}

export function evaluateLayer(layer, parameters, parameterDefinitions) {
  const transform = { ...layer.transform };
  const vertices = [...layer.mesh.vertices];

  for (const [parameterId, keyforms] of Object.entries(layer.keyforms)) {
    const definition = parameterDefinitions[parameterId];
    if (!definition) continue;
    let value = Number(parameters[parameterId] ?? definition.default);
    // A single shared blink remains compatible with old rigs. Per-eye closure
    // and squint drive the same authored lid pose without adding two closures.
    const side = layer.eyeSide ?? (/^Left /.test(layer.name) ? "Left" : /^Right /.test(layer.name) ? "Right" : null);
    if (parameterId === "eyes.blink" && side) value = Math.min(1, Math.max(value, Number(parameters[`eyes.blink${side}`] ?? 0), Number(parameters["eyes.squint"] ?? 0) * .7));
    const pose = interpolateKeyforms(
      keyforms,
      value,
      Number(definition.default),
      vertices.length,
    );
    for (const property of Object.keys(transform)) {
      transform[property] += pose.transform[property] ?? 0;
    }
    for (let index = 0; index < vertices.length; index += 1) {
      vertices[index] += pose.offsets[index] ?? 0;
    }
  }

  for (const corrective of layer.correctives ?? []) {
    const weight = correctiveWeight(corrective.drivers, parameters, parameterDefinitions);
    for (const property of Object.keys(transform)) transform[property] += (corrective.transform?.[property] ?? 0) * weight;
    for (let i = 0; i < vertices.length; i++) vertices[i] += (corrective.offsets?.[i] ?? 0) * weight;
  }
  transform.opacity = Math.max(0, Math.min(1, transform.opacity));
  return { transform, vertices };
}

export function defaultParameterValues(model) {
  return Object.fromEntries(
    Object.entries(model.parameters).map(([id, parameter]) => [id, parameter.default]),
  );
}

export function parseModel(text) {
  const model = parseJson(text);
  const errors = validateModel(model);
  if (errors.length) throw new Error(errors.join("\n"));
  return model;
}

export function serializeModel(model) {
  const errors = validateModel(model);
  if (errors.length) throw new Error(errors.join("\n"));
  const text = `${JSON.stringify(model, null, 2)}\n`;
  if (new TextEncoder().encode(text).length > MODEL_LIMITS.fileBytes) throw new Error("Serialized model exceeds 64 MiB. Use smaller artwork or fewer keyforms.");
  return text;
}

export function safeFilename(name) {
  return (name || "puppet")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "puppet";
}
