import { createLayer, createModel, ensureKeyform } from "./model.js";

const AVATAR_ASSET = "./static/kokoro-chan.webp";

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
      return [direction * (24 + (v - 0.25) * 12) * weight, direction * (u - 0.5) * 7 * weight];
    });
    addWarpKey(layer, "head.pitch", direction, (u, v) => [0, direction * 17 * headWeight(u, v)]);
    addWarpKey(layer, "head.roll", direction, (u, v, x, y) => {
      const weight = headWeight(u, v);
      const centerY = -225;
      const angle = direction * 0.075 * weight;
      const dy = y - centerY;
      return [x * Math.cos(angle) - dy * Math.sin(angle) - x, x * Math.sin(angle) + dy * Math.cos(angle) - dy];
    });
    addWarpKey(layer, "body.sway", direction, (u, v) => {
      const weight = clamp((v - 0.35) / 0.65);
      return [direction * 26 * weight, direction * (u - 0.5) * 5 * weight];
    });
    addWarpKey(layer, "hair.motion", direction, (u, v) => {
      const edge = clamp(Math.abs(u - 0.5) * 2);
      const longHair = clamp((v - 0.18) / 0.82);
      const outsideFace = 1 - headWeight(u, v) * 0.8;
      return [direction * (8 + longHair * 22) * edge * outsideFace, 3 * edge * longHair];
    });
  }
}

function addHeadFollower(layer) {
  for (const direction of [-1, 1]) {
    addTransformKey(layer, "head.yaw", direction, { x: direction * 23, rotation: direction * 0.016 });
    addTransformKey(layer, "head.pitch", direction, { y: direction * 17 });
    addTransformKey(layer, "head.roll", direction, { rotation: direction * 0.075 });
  }
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
      <defs><radialGradient id="skin"><stop offset="0" stop-color="#f9d8d0"/><stop offset=".72" stop-color="#f5cbc8"/><stop offset="1" stop-color="#f5cbc8" stop-opacity="0"/></radialGradient></defs>
      <ellipse cx="38" cy="26" rx="37" ry="25" fill="url(#skin)"/>
      <path d="M10 27Q38 38 66 27" fill="none" stroke="#563744" stroke-width="3" stroke-linecap="round"/>
    `),
  });
  layer.transform.opacity = 0;
  addHeadFollower(layer);
  addTransformKey(layer, "eyes.blink", 0.12, { opacity: 0 });
  addTransformKey(layer, "eyes.blink", 1, { opacity: 1 });
  return layer;
}

function createMouth() {
  const width = 68;
  const height = 44;
  const layer = createLayer({
    name: "Animated Mouth",
    width,
    height,
    columns: 3,
    rows: 2,
    x: 0,
    y: -204,
    zIndex: 2,
    src: svgData(width, height, `
      <ellipse cx="34" cy="21" rx="25" ry="17" fill="#672b48" stroke="#4d293d" stroke-width="2"/>
      <path d="M17 30Q34 19 52 30Q43 38 34 38T17 30Z" fill="#ec8ca9"/>
      <path d="M14 13Q34 7 54 13" fill="none" stroke="#fff5f0" stroke-width="2" stroke-linecap="round" opacity=".92"/>
    `),
  });
  layer.transform.opacity = 0;
  layer.transform.scaleY = 0.24;
  addHeadFollower(layer);
  addTransformKey(layer, "mouth.open", 0.12, { opacity: 0 });
  addTransformKey(layer, "mouth.open", 1, { opacity: 1, scaleY: 0.76 });
  addTransformKey(layer, "mouth.form", -1, { scaleX: -0.2, rotation: -0.02 });
  addTransformKey(layer, "mouth.form", 1, { scaleX: 0.22 });
  return layer;
}

export function createSampleModel() {
  const model = createModel("Kokoro-chan");
  model.meta.author = "Kokoro2D";
  model.meta.license = "CC0 sample puppet";
  model.meta.artwork = "Original Kokoro2D default character";
  model.canvas.background = "#160e20";

  const portrait = createLayer({
    name: "Kokoro-chan Portrait",
    width: 620,
    height: 930,
    columns: 10,
    rows: 14,
    y: 0,
    zIndex: 0,
    src: AVATAR_ASSET,
  });
  addPortraitMotion(portrait);

  model.layers.push(
    portrait,
    createEyelid("Left Eyelid", -44),
    createEyelid("Right Eyelid", 47),
    createMouth(),
  );
  return model;
}
