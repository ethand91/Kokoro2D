import { attachToPortrait } from "./rig.js";
import { createLayer, createModel, ensureKeyform } from "./model.js";
import { sampleRegions, finishSampleRig } from "./sample-rig.js";

const AVATAR_ASSET = "./static/kokoro-chan.webp";
const SPEAK_ASSET = "./static/kokoro-chan-speak.webp";
const ART_SCALE = 620 / 768;

function svgData(width, height, body) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function addTransformKey(layer, parameter, value, transform) {
  Object.assign(ensureKeyform(layer, parameter, value).transform, transform);
}

function addWarpKey(layer, parameter, value, warp) {
  const key = ensureKeyform(layer, parameter, value);
  const { columns, rows, vertices } = layer.mesh;
  for (let index = 0; index < vertices.length; index += 2) {
    const vertex = index / 2;
    const column = vertex % (columns + 1);
    const row = Math.floor(vertex / (columns + 1));
    const u = column / columns;
    const v = row / rows;
    const [x, y] = warp(u, v, vertices[index], vertices[index + 1]);
    key.offsets[index] = x;
    key.offsets[index + 1] = y;
  }
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function addPortraitMotion(layer) {
  const headWeight = (u, v) => {
    const dx = (u - 0.5) / 0.36;
    const dy = (v - 0.255) / 0.235;
    return clamp(1 - Math.sqrt(dx * dx + dy * dy)) ** 0.58;
  };

  for (const direction of [-1, 1]) {
    addWarpKey(layer, "head.yaw", direction, (u, v) => {
      const weight = headWeight(u, v);
      return [direction * (8 + (v - 0.25) * 4) * weight, direction * (u - 0.5) * 2.5 * weight];
    });
    addWarpKey(layer, "head.pitch", direction, (u, v) => [0, direction * 7 * headWeight(u, v)]);
    addWarpKey(layer, "head.roll", direction, (u, v, x, y) => {
      const weight = headWeight(u, v);
      const centerY = -225;
      const angle = direction * 0.038 * weight;
      const dy = y - centerY;
      return [x * Math.cos(angle) - dy * Math.sin(angle) - x, x * Math.sin(angle) + dy * Math.cos(angle) - dy];
    });
    addWarpKey(layer, "body.sway", direction, (u, v) => {
      const weight = clamp((v - 0.35) / 0.65);
      return [direction * 11 * weight, direction * (u - 0.5) * 2 * weight];
    });
    addWarpKey(layer, "hair.motion", direction, (u, v) => {
      const edge = clamp(Math.abs(u - 0.5) * 2);
      const longHair = clamp((v - 0.18) / 0.82);
      const outsideFace = 1 - headWeight(u, v) * 0.8;
      return [direction * (3 + longHair * 8) * edge * outsideFace, 1.5 * edge * longHair];
    });
    addWarpKey(layer, "body.breathe", direction, (u, v) => {
      const chest = Math.exp(-(((v - 0.52) / 0.19) ** 2));
      return [direction * (u - 0.5) * 3 * chest, -direction * 2.4 * chest];
    });
  }
}

function createExpressionPatch({ name, asset, crop, position, zIndex, parameter }) {
  const layer = createLayer({
    name,
    width: crop.width * ART_SCALE,
    height: crop.height * ART_SCALE,
    columns: 4,
    rows: 3,
    x: position?.x ?? (crop.x + crop.width / 2 - 384) * ART_SCALE,
    y: position?.y ?? (crop.y + crop.height / 2 - 576) * ART_SCALE,
    zIndex,
    src: asset,
  });
  layer.source.crop = crop;
  layer.source.feather = 0.05;
  layer.source.mask = "ellipse";
  layer.transform.opacity = 0;
  addTransformKey(layer, parameter, 0.08, { opacity: 0 });
  addTransformKey(layer, parameter, 1, { opacity: 1 });
  if (parameter === "mouth.open") {
    addTransformKey(layer, "mouth.form", -1, { scaleX: -0.06 });
    addTransformKey(layer, "mouth.form", 1, { scaleX: 0.06 });
  }
  return layer;
}

function createEyelid(name, x) {
  const width = 76;
  const height = 52;
  const layer = createLayer({
    name,
    width,
    height,
    columns: 3,
    rows: 2,
    x,
    y: -249,
    zIndex: 1,
    src: svgData(width, height, `
      <defs><radialGradient id="skin"><stop offset="0" stop-color="#fbe0da"/><stop offset=".68" stop-color="#f7d1cd"/><stop offset="1" stop-color="#f7d1cd" stop-opacity="0"/></radialGradient></defs>
      <ellipse cx="38" cy="26" rx="37" ry="25" fill="url(#skin)"/>
      <path d="M9 25Q38 39 67 25" fill="none" stroke="#4b293e" stroke-width="3.4" stroke-linecap="round"/>
      <path d="M13 23 8 20M63 23l5-4" fill="none" stroke="#4b293e" stroke-width="2" stroke-linecap="round"/>
    `),
  });
  layer.transform.opacity = 0;
  addTransformKey(layer, "eyes.blink", 0.1, { opacity: 0 });
  addTransformKey(layer, "eyes.blink", 1, { opacity: 1 });
  return layer;
}

export function createSampleModel() {
  const model = createModel("Kokoro-chan");
  model.meta.author = "Kokoro2D";
  model.meta.license = "CC0 sample puppet";
  model.meta.artwork = "Original Kokoro2D default character";
  model.canvas.background = "#160e20";
  model.parameters["body.breathe"] = {
    id: "body.breathe",
    name: "Breathing",
    min: -1,
    max: 1,
    default: 0,
  };
  model.physics[0].strength = -0.28;
  model.physics[0].damping = 0.82;

  const portrait = createLayer({
    name: "Kokoro-chan Portrait",
    width: 620,
    height: 930,
    columns: 20,
    rows: 28,
    y: 0,
    zIndex: 0,
    src: AVATAR_ASSET,
  });
  addPortraitMotion(portrait);

  model.layers.push(
    portrait,
    createEyelid("Natural Left Eyelid", -44),
    createEyelid("Natural Right Eyelid", 47),
    createExpressionPatch({
      name: "Natural Speaking Mouth",
      asset: SPEAK_ASSET,
      crop: { x: 367, y: 310, width: 52, height: 34 },
      position: { x: 0, y: -204 },
      zIndex: 2,
      parameter: "mouth.open",
    }),
  );
  for (const patch of model.layers.slice(1)) attachToPortrait(patch, portrait);
  return model;
}

// Browser sample uses the same layered pipeline as imported portraits, with
// reviewed landmarks for the bundled artwork instead of colour-based guesses.
export async function createLayeredSampleModel() {
  const { prepareAutoRig } = await import('./auto-rigger.js');
  const { buildLayeredRig } = await import('./layered-rig.js');
  const response = await fetch(AVATAR_ASSET);
  if (!response.ok) throw new Error('Unable to load sample artwork.');
  const prepared = await prepareAutoRig(new File([await response.blob()], 'Kokoro-chan.webp', { type:'image/webp' }), 'anime', { detectLandmarks:false });
  const regions = sampleRegions();
  const model = buildLayeredRig(prepared.imageData,prepared.analysis,regions,'Kokoro-chan');
  model.meta.author='Kokoro2D'; model.meta.license='CC0 sample puppet';
  model.meta.artwork='Original Kokoro2D character with reviewed outlines and painted eyes';
  return finishSampleRig(model,prepared.imageData,prepared.analysis);
}
