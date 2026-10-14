import { MODEL_LIMITS as L } from "./import-limits.js";
import { textureSource, dataImageBytes, imageInfo } from "./texture-source.js";

const own = (object, key) => Object.hasOwn(object, key);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (path, message) => { throw new Error(`${path}: ${message}`); };
const need = (condition, path, message) => { if (!condition) fail(path, message); };
const finite = (value, path, min = -L.coordinate, max = L.coordinate) => need(Number.isFinite(value) && value >= min && value <= max, path, `must be finite and between ${min} and ${max}.`);
const string = (value, path, empty = false) => need(typeof value === "string" && (empty || value.length > 0) && value.length <= L.stringLength, path, `must be ${empty ? "a" : "a nonempty"} string of at most ${L.stringLength} characters.`);
const id = (value, path) => { string(value, path); need(value.length <= 128 && !["__proto__", "constructor", "prototype"].includes(value), path, "invalid identifier (maximum 128 characters)."); };
const array = (value, path, maximum) => need(Array.isArray(value) && value.length <= maximum, path, `must be an array with at most ${maximum} items.`);
const object = (value, path) => need(record(value), path, "must be an object.");

// Unknown extension metadata is retained, but must remain bounded JSON data.
export function validateJsonTree(root) {
  let values = 0, chars = 0;
  const ancestors = new Set();
  function visit(value, path, depth, key) {
    need(++values <= L.jsonValues, path, "model contains too many values.");
    need(depth <= L.jsonDepth, path, "model nesting is too deep.");
    if (typeof value === "number") { need(Number.isFinite(value), path, "must be finite."); return; }
    if (typeof value === "string") {
      chars += value.length;
      need(chars <= L.fileBytes, path, "model string data exceeds 64 MiB.");
      need(value.length <= (key === "src" ? L.imageBytes * 4 : L.stringLength), path, "string is too long.");
      return;
    }
    if (value === null || typeof value === "boolean") return;
    need(Array.isArray(value) || record(value), path, "must contain only JSON data.");
    need(!ancestors.has(value), path, "cyclic object data is not supported.");
    ancestors.add(value);
    if (Array.isArray(value)) {
      need(value.length <= L.jsonValues - values, path, "array exceeds the model value budget.");
      for (let i = 0; i < value.length; i++) visit(value[i], `${path}[${i}]`, depth + 1, "");
    } else for (const key of Object.keys(value)) {
      need(!["__proto__", "constructor", "prototype"].includes(key) && key.length <= 128, path, "unsafe or oversized object key.");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      need(own(descriptor, "value"), path, "accessor properties are not model data.");
      visit(descriptor.value, `${path}.${key}`, depth + 1, key);
    }
    ancestors.delete(value);
  }
  visit(root, "model", 0, "");
}

export const MOTION_RANGES = Object.freeze({
  speechStrength: [0, 1.5], turnSize: [0, 1], turnRate: [.1, 1.4], tiltSize: [0, .4],
  tiltGesture: [0, 1], tiltChance: [0, 1], bob: [0, .15], headDeadZone: [0, .6],
  headGain: [0, 1.5], vorGain: [0, 1], headRate: [4, 30], eyeRate: [8, 40],
  microsaccade: [0, .06], breathRate: [.12, .5], lidFollow: [0, .8], idleMouth: [0, .6],
  swaySize: [0, 1], bodyFollow: [0, .6], bodyRate: [2, 12], shiftSize: [0, 1.5], bounceDrive: [0, .6],
});

export function validateModel(candidate, { archive = false } = {}) {
  try {
    validateJsonTree(candidate);
    object(candidate, "model");
    need(candidate.schema === "kokoro2d", "schema", "must be kokoro2d.");
    need([1, 2, 3].includes(candidate.version), "version", "unsupported schema version; expected 1, 2 or 3.");
    object(candidate.meta, "meta"); string(candidate.meta.name, "meta.name");
    for (const field of ["author", "license", "id", "createdAt", "modifiedAt", "generator"]) if (own(candidate.meta, field)) string(candidate.meta[field], `meta.${field}`, true);
    object(candidate.canvas, "canvas");
    for (const field of ["width", "height"]) finite(candidate.canvas[field], `canvas.${field}`, 1, L.imageSide);
    if (own(candidate.canvas, "background")) string(candidate.canvas.background, "canvas.background", true);
    object(candidate.parameters, "parameters");
    const parameters = candidate.parameters, definitions = Object.entries(parameters);
    need(definitions.length > 0 && definitions.length <= L.parameters, "parameters", `requires 1–${L.parameters} definitions.`);
    for (const [key, parameter] of definitions) {
      id(key, `parameters.${key}`); object(parameter, `parameters.${key}`);
      need(parameter.id === key, `parameters.${key}.id`, "must match its parameter key.");
      string(parameter.name, `parameters.${key}.name`);
      finite(parameter.min, `parameters.${key}.min`); finite(parameter.max, `parameters.${key}.max`);
      need(parameter.min < parameter.max, `parameters.${key}`, "min must be smaller than max.");
      finite(parameter.default, `parameters.${key}.default`, parameter.min, parameter.max);
    }
    array(candidate.layers, "layers", L.layers);
    const groups = candidate.groups ?? [];
    array(groups, "groups", L.groups);
    const layersById = new Map(), groupsById = new Map();
    const index = (items, map, label) => items.forEach((item, i) => {
      object(item, `${label}[${i}]`); id(item.id, `${label}[${i}].id`);
      need(!map.has(item.id), `${label}[${i}].id`, "ids must be unique."); map.set(item.id, item);
    });
    index(candidate.layers, layersById, "layers"); index(groups, groupsById, "groups");
    let totalVertices = 0, poseValues = 0, embeddedBytes = 0, texturePixels = 0;
    const sources = new Map();
    const optionalNumber = (item, field, path, min, max) => { if (own(item, field)) finite(item[field], `${path}.${field}`, min, max); };
    const transform = (value, path, partial = false) => {
      object(value, path);
      for (const key of ["x", "y", "rotation", "scaleX", "scaleY", "opacity"]) {
        if (partial && !own(value, key)) continue;
        finite(value[key], `${path}.${key}`, key === "opacity" && !partial ? 0 : -L.coordinate, key === "opacity" && !partial ? 1 : L.coordinate);
      }
    };
    const geometry = (mesh, path, uvs = true) => {
      object(mesh, path); array(mesh.vertices, `${path}.vertices`, L.vertices * 2);
      const vertices = mesh.vertices.length / 2;
      need(Number.isInteger(vertices) && vertices >= 3, `${path}.vertices`, "must contain at least three x/y vertex pairs.");
      for (const value of mesh.vertices) finite(value, `${path}.vertices`);
      if (uvs) {
        array(mesh.uvs, `${path}.uvs`, L.vertices * 2);
        need(mesh.uvs.length === mesh.vertices.length, `${path}.uvs`, "must match vertex count.");
        for (const value of mesh.uvs) finite(value, `${path}.uvs`, 0, 1);
      }
      array(mesh.indices, `${path}.indices`, L.triangles * 3);
      need(mesh.indices.length >= 3 && mesh.indices.length % 3 === 0, `${path}.indices`, "must contain triangles.");
      for (const value of mesh.indices) need(Number.isInteger(value) && value >= 0 && value < vertices, `${path}.indices`, "triangle index out of bounds.");
      if (own(mesh, "columns") || own(mesh, "rows")) {
        need(Number.isInteger(mesh.columns) && mesh.columns > 0 && Number.isInteger(mesh.rows) && mesh.rows > 0 && (mesh.columns + 1) * (mesh.rows + 1) === vertices, path, "grid rows/columns must match vertex count.");
      }
      return vertices;
    };
    const appearance = (item, path) => {
      if (own(item, "visible")) need(typeof item.visible === "boolean", `${path}.visible`, "must be boolean.");
      optionalNumber(item, "zIndex", path);
      if (item.blendMode != null) need(["normal", "multiply", "screen", "overlay"].includes(item.blendMode), `${path}.blendMode`, "unsupported blend mode.");
      if (item.clipMask != null) need(layersById.has(item.clipMask), `${path}.clipMask`, "missing clipping layer.");
    };
    for (const [i, group] of groups.entries()) {
      const path = `groups[${i}]`; appearance(group, path); optionalNumber(group, "opacity", path, 0, 1);
      if (own(group, "name")) string(group.name, `${path}.name`, true);
      if (group.parent != null) need(groupsById.has(group.parent), `${path}.parent`, "missing parent group.");
    }
    for (const [i, layer] of candidate.layers.entries()) {
      const path = `layers[${i}]`;
      string(layer.name, `${path}.name`, true); appearance(layer, path); transform(layer.transform, `${path}.transform`);
      if (layer.group != null) need(groupsById.has(layer.group), `${path}.group`, "missing compositing group.");
      if (layer.eyeSide != null) need(["Left", "Right"].includes(layer.eyeSide), `${path}.eyeSide`, "must be Left or Right.");
      totalVertices += geometry(layer.mesh, `${path}.mesh`);
      need(totalVertices <= L.totalVertices, "layers", `total vertex count exceeds ${L.totalVertices}.`);
      const source = layer.source; object(source, `${path}.source`);
      need(source.type === undefined || ["embedded", "external", ...(archive ? ["archive"] : [])].includes(source.type), `${path}.source.type`, "unsupported artwork source type.");
      optionalNumber(source, "width", `${path}.source`, Number.EPSILON, L.imageSide);
      optionalNumber(source, "height", `${path}.source`, Number.EPSILON, L.imageSide);
      if (source.crop != null) {
        object(source.crop, `${path}.source.crop`);
        for (const key of ["x", "y", "width", "height"]) finite(source.crop[key], `${path}.source.crop.${key}`, key === "x" || key === "y" ? 0 : Number.EPSILON, L.imageSide);
      }
      optionalNumber(source, "feather", `${path}.source`, 0, .49);
      if (source.mask != null) need(source.mask === "ellipse", `${path}.source.mask`, "unsupported mask shape.");
      if (archive && source.type === "archive") string(source.src, `${path}.source.src`);
      else {
        if (!sources.has(source.src)) {
          let info;
          try {
            const parsed = textureSource(source.src);
            if (parsed.embedded) {
              const bytes = dataImageBytes(parsed);
              info = imageInfo(bytes, parsed.type); embeddedBytes += bytes.length; texturePixels += info.width * info.height;
              need(embeddedBytes <= L.embeddedBytes, path, "unique embedded artwork exceeds 64 MiB.");
              need(texturePixels <= L.texturePixels, path, "decoded artwork exceeds 64 megapixels.");
            }
          } catch (error) { fail(`${path}.source.src`, error.message); }
          sources.set(source.src, info);
        }
        const info = sources.get(source.src), crop = source.crop;
        if (info && crop) need(crop.x + crop.width <= info.width + 1e-6 && crop.y + crop.height <= info.height + 1e-6, `${path}.source.crop`, "crop extends beyond decoded artwork.");
      }
      object(layer.keyforms, `${path}.keyforms`);
      const pose = (key, path) => {
        object(key, path); array(key.offsets, `${path}.offsets`, L.vertices * 2);
        need(key.offsets.length === layer.mesh.vertices.length, `${path}.offsets`, "must match its mesh.");
        poseValues += key.offsets.length;
        need(poseValues <= L.poseValues, path, `pose offsets exceed ${L.poseValues} values.`);
        for (const value of key.offsets) finite(value, `${path}.offsets`);
        if (own(key, "transform")) transform(key.transform, `${path}.transform`, true);
      };
      for (const [parameterId, keys] of Object.entries(layer.keyforms)) {
        need(own(parameters, parameterId), `${path}.keyforms.${parameterId}`, "unknown parameter.");
        array(keys, `${path}.keyforms.${parameterId}`, L.keysPerChannel);
        const seen = new Set();
        for (const [k, key] of keys.entries()) {
          const kp = `${path}.keyforms.${parameterId}[${k}]`; pose(key, kp);
          finite(key.value, `${kp}.value`, parameters[parameterId].min, parameters[parameterId].max);
          need(!seen.has(key.value), kp, "duplicate keyform value."); seen.add(key.value);
        }
      }
      if (own(layer, "correctives")) {
        array(layer.correctives, `${path}.correctives`, L.correctives);
        for (const [c, corrective] of layer.correctives.entries()) {
          const cp = `${path}.correctives[${c}]`; pose(corrective, cp); object(corrective.drivers, `${cp}.drivers`);
          const drivers = Object.entries(corrective.drivers); need(drivers.length >= 2 && drivers.length <= 8, cp, "correctives require 2–8 drivers.");
          for (const [key, value] of drivers) {
            need(own(parameters, key), `${cp}.drivers`, "unknown parameter.");
            finite(value, `${cp}.drivers.${key}`, parameters[key].min, parameters[key].max);
            need(value !== parameters[key].default, cp, "corrective target must differ from neutral.");
          }
        }
      }
      if (layer.parent != null) {
        object(layer.parent, `${path}.parent`);
        need(layersById.has(layer.parent.id), `${path}.parent.id`, "missing parent.");
        const binding = layer.parent.bind; geometry(binding, `${path}.parent.bind`, false); transform(binding.transform, `${path}.parent.bind.transform`);
        need(binding.vertices.length === layersById.get(layer.parent.id).mesh?.vertices?.length, `${path}.parent.bind`, "vertex count must match parent.");
        need(binding.transform.scaleX !== 0 && binding.transform.scaleY !== 0, `${path}.parent.bind.transform`, "binding scale must be nonzero.");
      }
    }
    const hierarchy = (map, next, label) => {
      for (const item of map.values()) {
        const seen = new Set(); let current = item;
        while (current) {
          need(!seen.has(current.id), label, `cyclic hierarchy (Cyclic ${label} references).`);
          need(seen.size < L.hierarchyDepth, label, `hierarchy exceeds ${L.hierarchyDepth} levels.`);
          seen.add(current.id); current = map.get(next(current));
        }
      }
    };
    hierarchy(layersById, layer => layer.parent?.id, "parent");
    hierarchy(layersById, layer => layer.clipMask, "mask");
    hierarchy(groupsById, group => group.parent, "group");
    if (own(candidate, "physics")) {
      array(candidate.physics, "physics", L.parameters);
      for (const [i, spring] of candidate.physics.entries()) {
        const path = `physics[${i}]`; object(spring, path);
        need(own(parameters, spring.input) && own(parameters, spring.output), path, "input/output must reference declared parameters.");
        optionalNumber(spring, "frequency", path, .1, 12); optionalNumber(spring, "damping", path, .05, 2); optionalNumber(spring, "strength", path, -10, 10);
      }
    }
    if (candidate.meta.motion != null) {
      const motion = candidate.meta.motion; object(motion, "meta.motion");
      need(["calm", "energetic"].includes(motion.style), "meta.motion.style", "unsupported motion style.");
      if (own(motion, "overrides")) {
        object(motion.overrides, "meta.motion.overrides");
        for (const [key, value] of Object.entries(motion.overrides)) {
          need(own(MOTION_RANGES, key), `meta.motion.overrides.${key}`, "unsupported motion setting.");
          finite(value, `meta.motion.overrides.${key}`, ...MOTION_RANGES[key]);
        }
      }
    }
    // The current runtime has no timeline/animation schema. Never imply these execute.
    if (own(candidate, "animations")) need(Array.isArray(candidate.animations) && candidate.animations.length === 0, "animations", "timeline animations are unsupported; author motion with parameter keyforms and meta.motion.");
    return [];
  } catch (error) { return [error.message]; }
}
