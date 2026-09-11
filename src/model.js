export const SCHEMA = "kokoro2d";
export const SCHEMA_VERSION = 1;

export const STANDARD_PARAMETERS = Object.freeze([
  { id: "head.yaw", name: "Head Yaw", min: -1, max: 1, default: 0 },
  { id: "head.pitch", name: "Head Pitch", min: -1, max: 1, default: 0 },
  { id: "head.roll", name: "Head Roll", min: -1, max: 1, default: 0 },
  { id: "eyes.blink", name: "Eye Blink", min: 0, max: 1, default: 0 },
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
      generator: "Kokoro2D Maker 0.1.0",
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

export function evaluateLayer(layer, parameters, parameterDefinitions) {
  const transform = { ...layer.transform };
  const vertices = [...layer.mesh.vertices];

  for (const [parameterId, keyforms] of Object.entries(layer.keyforms)) {
    const definition = parameterDefinitions[parameterId];
    if (!definition) continue;
    const value = Number(parameters[parameterId] ?? definition.default);
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

  transform.opacity = Math.max(0, Math.min(1, transform.opacity));
  return { transform, vertices };
}

export function defaultParameterValues(model) {
  return Object.fromEntries(
    Object.entries(model.parameters).map(([id, parameter]) => [id, parameter.default]),
  );
}

export function validateModel(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== "object") return ["Model must be an object."];
  if (candidate.schema !== SCHEMA) errors.push(`schema must be ${SCHEMA}.`);
  if (candidate.version !== SCHEMA_VERSION) errors.push(`Unsupported schema version ${candidate.version}.`);
  if (!candidate.meta?.name) errors.push("meta.name is required.");
  if (!candidate.canvas || candidate.canvas.width <= 0 || candidate.canvas.height <= 0) {
    errors.push("canvas dimensions must be positive.");
  }
  if (!candidate.parameters || typeof candidate.parameters !== "object") {
    errors.push("parameters must be an object.");
  }
  if (!Array.isArray(candidate.layers)) {
    errors.push("layers must be an array.");
    return errors;
  }

  const ids = new Set();
  candidate.layers.forEach((layer, layerIndex) => {
    const label = `layers[${layerIndex}]`;
    if (!layer.id) errors.push(`${label}.id is required.`);
    if (ids.has(layer.id)) errors.push(`${label}.id must be unique.`);
    ids.add(layer.id);
    if (!layer.source?.src) errors.push(`${label}.source.src is required.`);
    if (!Array.isArray(layer.mesh?.vertices) || layer.mesh.vertices.length % 2 !== 0) {
      errors.push(`${label}.mesh.vertices must contain x/y pairs.`);
    }
    if (!Array.isArray(layer.mesh?.uvs) || layer.mesh.uvs.length !== layer.mesh.vertices?.length) {
      errors.push(`${label}.mesh.uvs must match vertex count.`);
    }
    if (!Array.isArray(layer.mesh?.indices) || layer.mesh.indices.length % 3 !== 0) {
      errors.push(`${label}.mesh.indices must contain triangles.`);
    }
    for (const [parameterId, keyforms] of Object.entries(layer.keyforms ?? {})) {
      if (!candidate.parameters?.[parameterId]) errors.push(`${label} references unknown ${parameterId}.`);
      for (const keyform of keyforms) {
        if (keyform.offsets?.length !== layer.mesh.vertices?.length) {
          errors.push(`${label} ${parameterId} keyform offsets do not match its mesh.`);
        }
      }
    }
  });
  return errors;
}

export function parseModel(text) {
  const model = JSON.parse(text);
  const errors = validateModel(model);
  if (errors.length) throw new Error(errors.join("\n"));
  return model;
}

export function serializeModel(model) {
  const errors = validateModel(model);
  if (errors.length) throw new Error(errors.join("\n"));
  return `${JSON.stringify(model, null, 2)}\n`;
}

export function safeFilename(name) {
  return (name || "puppet")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "puppet";
}
