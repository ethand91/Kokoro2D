import { createLayer, createModel, ensureKeyform } from "./model.js";

function svgData(width, height, body) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function addKey(layer, parameter, value, transform = {}, vertexEdits = []) {
  const key = ensureKeyform(layer, parameter, value);
  Object.assign(key.transform, transform);
  for (const [vertexIndex, x, y] of vertexEdits) {
    key.offsets[vertexIndex * 2] = x;
    key.offsets[vertexIndex * 2 + 1] = y;
  }
}

export function createSampleModel() {
  const model = createModel("Kokoro-chan");
  model.meta.author = "Kokoro2D";
  model.meta.license = "CC0 sample puppet";
  model.canvas.background = "#1b1126";

  const hairBack = createLayer({
    name: "Back Hair",
    width: 520,
    height: 620,
    columns: 5,
    rows: 6,
    y: 25,
    zIndex: 0,
    src: svgData(520, 620, `
      <defs><linearGradient id="h" x2="0" y2="1"><stop stop-color="#6040a5"/><stop offset="1" stop-color="#2e1d5e"/></linearGradient></defs>
      <path d="M260 25C95 25 42 155 58 329c8 94 1 190-35 255 62 18 111-8 142-49 17 42 53 67 95 67s78-25 95-67c31 41 80 67 142 49-36-65-43-161-35-255C478 155 425 25 260 25Z" fill="url(#h)" stroke="#ad8df4" stroke-width="8"/>
    `),
  });
  addKey(hairBack, "hair.motion", -1, { rotation: -0.035 }, [[35, -24, 0], [34, -18, 0], [41, -35, 0]]);
  addKey(hairBack, "hair.motion", 1, { rotation: 0.035 }, [[35, 24, 0], [34, 18, 0], [41, 35, 0]]);

  const ears = createLayer({
    name: "Cat Ears",
    width: 430,
    height: 190,
    columns: 3,
    rows: 2,
    y: -235,
    zIndex: 1,
    src: svgData(430, 190, `
      <path d="M25 167 70 18l125 129Z" fill="#6040a5" stroke="#ad8df4" stroke-width="8" stroke-linejoin="round"/>
      <path d="m235 147 125-129 45 149Z" fill="#6040a5" stroke="#ad8df4" stroke-width="8" stroke-linejoin="round"/>
      <path d="M58 139 78 65l69 72Z" fill="#f5a8d6"/><path d="m283 137 69-72 20 74Z" fill="#f5a8d6"/>
    `),
  });
  addKey(ears, "head.yaw", -1, { x: -18, rotation: -0.04 });
  addKey(ears, "head.yaw", 1, { x: 18, rotation: 0.04 });

  const body = createLayer({
    name: "Body",
    width: 440,
    height: 390,
    columns: 4,
    rows: 4,
    y: 360,
    zIndex: 2,
    src: svgData(440, 390, `
      <defs><linearGradient id="b"><stop stop-color="#df73bd"/><stop offset="1" stop-color="#7545b8"/></linearGradient></defs>
      <path d="M92 373c4-171 38-278 128-278s124 107 128 278Z" fill="url(#b)" stroke="#f6c1e5" stroke-width="8"/>
      <path d="m143 111 77 78 77-78-24-42H167Z" fill="#fff1fa"/>
      <path d="m220 188-30 57 30 41 30-41Z" fill="#ffd45d"/>
    `),
  });
  addKey(body, "body.sway", -1, { x: -35, rotation: -0.055 });
  addKey(body, "body.sway", 1, { x: 35, rotation: 0.055 });

  const face = createLayer({
    name: "Face",
    width: 390,
    height: 455,
    columns: 5,
    rows: 5,
    y: -15,
    zIndex: 3,
    src: svgData(390, 455, `
      <defs><radialGradient id="s" cx="45%" cy="38%"><stop stop-color="#fffaf7"/><stop offset="1" stop-color="#f3c5c8"/></radialGradient></defs>
      <path d="M195 21C87 21 33 111 48 232c12 101 65 187 147 187s135-86 147-187C357 111 303 21 195 21Z" fill="url(#s)" stroke="#4a2c66" stroke-width="7"/>
      <ellipse cx="101" cy="276" rx="37" ry="17" fill="#f38fae" opacity=".42"/><ellipse cx="289" cy="276" rx="37" ry="17" fill="#f38fae" opacity=".42"/>
    `),
  });
  addKey(face, "head.yaw", -1, { x: -22, rotation: -0.025 });
  addKey(face, "head.yaw", 1, { x: 22, rotation: 0.025 });
  addKey(face, "head.pitch", -1, { y: -18, scaleY: 0.025 });
  addKey(face, "head.pitch", 1, { y: 18, scaleY: -0.025 });
  addKey(face, "head.roll", -1, { rotation: -0.12 });
  addKey(face, "head.roll", 1, { rotation: 0.12 });

  const eyes = createLayer({
    name: "Eyes",
    width: 285,
    height: 90,
    columns: 4,
    rows: 2,
    y: -70,
    zIndex: 4,
    src: svgData(285, 90, `
      <path d="M10 48Q52 4 101 48Q53 82 10 48Zm174 0q49-44 91 0-43 34-91 0Z" fill="#fff" stroke="#42265b" stroke-width="7"/>
      <ellipse cx="58" cy="46" rx="18" ry="29" fill="#8f65e8"/><ellipse cx="227" cy="46" rx="18" ry="29" fill="#8f65e8"/>
      <ellipse cx="58" cy="48" rx="8" ry="18" fill="#21152e"/><ellipse cx="227" cy="48" rx="8" ry="18" fill="#21152e"/>
      <circle cx="52" cy="35" r="5" fill="#fff"/><circle cx="221" cy="35" r="5" fill="#fff"/>
    `),
  });
  addKey(eyes, "eyes.blink", 1, { scaleY: -0.88, y: 2 });
  addKey(eyes, "eyes.lookX", -1, { x: -8 });
  addKey(eyes, "eyes.lookX", 1, { x: 8 });
  addKey(eyes, "eyes.lookY", -1, { y: -6 });
  addKey(eyes, "eyes.lookY", 1, { y: 6 });
  addKey(eyes, "head.yaw", -1, { x: -30 });
  addKey(eyes, "head.yaw", 1, { x: 30 });

  const mouth = createLayer({
    name: "Mouth",
    width: 125,
    height: 72,
    columns: 3,
    rows: 2,
    y: 78,
    zIndex: 5,
    src: svgData(125, 72, `
      <path d="M8 27Q63 3 117 27Q105 67 63 68Q20 67 8 27Z" fill="#6d244d" stroke="#49213e" stroke-width="6"/>
      <path d="M27 54q36-21 71 0-17 13-35 13S42 63 27 54Z" fill="#f58eb7"/>
    `),
  });
  mouth.transform.scaleY = 0.12;
  addKey(mouth, "mouth.open", 1, { scaleY: 0.88 });
  addKey(mouth, "mouth.form", -1, { scaleX: -0.25, rotation: -0.025 });
  addKey(mouth, "mouth.form", 1, { scaleX: 0.28 });
  addKey(mouth, "head.yaw", -1, { x: -25 });
  addKey(mouth, "head.yaw", 1, { x: 25 });

  const fringe = createLayer({
    name: "Front Hair",
    width: 430,
    height: 235,
    columns: 5,
    rows: 3,
    y: -172,
    zIndex: 6,
    src: svgData(430, 235, `
      <defs><linearGradient id="f"><stop stop-color="#9872e8"/><stop offset="1" stop-color="#583590"/></linearGradient></defs>
      <path d="M22 113C51 18 139-12 221 12c94-27 174 30 190 118-38-22-69-27-101-18-8 53-40 88-84 108 2-34-4-66-20-93-21 44-54 75-98 91 13-39 13-77 2-113-27 31-57 49-88 52Z" fill="url(#f)" stroke="#4b2b74" stroke-width="7" stroke-linejoin="round"/>
    `),
  });
  addKey(fringe, "head.yaw", -1, { x: -19, rotation: -0.025 });
  addKey(fringe, "head.yaw", 1, { x: 19, rotation: 0.025 });
  addKey(fringe, "hair.motion", -1, { rotation: -0.025 });
  addKey(fringe, "hair.motion", 1, { rotation: 0.025 });

  model.layers.push(hairBack, ears, body, face, eyes, mouth, fringe);
  return model;
}
