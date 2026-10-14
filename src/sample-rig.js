import { createLayer, ensureKeyform } from "./model.js";
import { bindParent } from "./scene.js";
import { eyeProfile, regionContains, updateContourBounds } from "./region-geometry.js";
import { sampleEyeAperture, sampleLidProfile, authorSampleBlink } from "./sample-blink.js";

const clamp = (v) => Math.max(0, Math.min(1, v));
const smooth = (v) => { const t = clamp(v); return t * t * (3 - 2 * t); };

// Reviewed against the source artwork, including the outer lashes. A fresh
// copy lets the placement editor change outlines without changing the sample.
export function sampleRegions() {
  const feature = (contour, extra = {}) => updateContourBounds({ contour, ...extra });
  return {
    face: { x: 280, y: 180, width: 225, height: 190 },
    leftEye: feature([[277,267],[284,244],[304,232],[326,232],[350,241],[362,257],[365,279],[350,291],[330,295],[309,291],[293,281]]),
    rightEye: feature([[405,251],[411,232],[427,220],[455,214],[473,220],[491,239],[483,260],[470,274],[448,282],[427,279],[413,269]]),
    mouth: feature([[376,320],[384,323],[394,324],[403,321],[409,317],[409,322],[402,326],[392,328],[382,327],[376,324]], { sourceClosed: true }),
    backHair: { x: 130, y: 120, width: 530, height: 680 },
    bangs: { x: 193, y: 0, width: 390, height: 269 },
    leftHair: { x: 0, y: 120, width: 320, height: 680 },
    rightHair: { x: 470, y: 100, width: 298, height: 710 },
  };
}

function warp(layer, id, value, fn) {
  const key = ensureKeyform(layer, id, value);
  for (let i = 0; i < layer.mesh.vertices.length; i += 2) {
    const [x, y] = fn(layer.mesh.vertices[i], layer.mesh.vertices[i + 1], layer.mesh.uvs[i], layer.mesh.uvs[i + 1]);
    key.offsets[i] = x;
    key.offsets[i + 1] = y;
  }
}

export function authorSampleMotion(model, subject) {
  const scale = Math.min(900 / subject.height, 840 / subject.width);
  const face = model.meta.regions.face;
  const origin = { x: subject.x + subject.width / 2, y: subject.y + subject.height / 2 };
  const head = model.layers.find(layer => layer.name === "Head Deformer");
  const root = model.layers.find(layer => layer.name === "Portrait Deformer");
  const centerX = (face.x + face.width / 2 - origin.x) * scale - head.transform.x;
  const centerY = (face.y + face.height * .55 - origin.y) * scale - head.transform.y;
  // The jaw sits on the neck, and the neck is in the torso, which this cage
  // does not reach. Perspective that still moved the chin slid the jaw 4.6px
  // across the neck on a turn - a head wobbling on its stalk - so it fades out
  // between the mouth and the chin, leaving the jaw to the shared cage alone.
  const jawY = (face.y + face.height * .7 - origin.y) * scale - head.transform.y;
  const chinY = (face.y + face.height - origin.y) * scale - head.transform.y;
  const jaw = (y) => 1 - smooth((y - jawY) / (chinY - jawY));
  // Shared motion keeps attachments together; local perspective changes the
  // face's shape instead of simply sliding the portrait sideways.
  for (const d of [-1, 1]) {
    warp(head, "head.yaw", d, (x, y) => {
      const dx = x - centerX, dy = y - centerY;
      const weight = Math.exp(-((dx / (face.width * scale * .8)) ** 2 + (dy / (face.height * scale * .85)) ** 2)) * jaw(y);
      return [(d * face.width * scale * .035 - dx * .045) * weight, -d * dx * .018 * weight];
    });
    warp(head, "head.pitch", d, (x, y) => {
      const dx = x - centerX, dy = y - centerY;
      const weight = Math.exp(-((dx / (face.width * scale)) ** 2 + (dy / (face.height * scale)) ** 2)) * jaw(y);
      return [d * dx * .025 * weight, -d * dy * .055 * weight];
    });
    warp(root, "body.bounce", d, (x, y, u, v) => [0, -d * 4 * (1 - smooth((v - .28) / .72))]);
  }
  // Accessories stay anchored to their hair mass. Softer springs reduce the
  // edge exposure of a rig made from one image, while tips still trail roots.
  const tuning = {
    "bangs": [-.38, 3.4, .86], "left-root": [-.55, 2.1, .78],
    "left-tip": [.85, 1.35, .7], "right-root": [-.5, 2.35, .8],
    "right-tip": [.85, 1.5, .72],
  };
  for (const spring of model.physics) {
    const values = tuning[spring.id];
    if (values) [spring.strength, spring.frequency, spring.damping] = values;
  }
}

const canvas = (w, h) => Object.assign(document.createElement("canvas"), { width: Math.ceil(w), height: Math.ceil(h) });
const decode = async (src) => { const img = new Image(); img.src = src; await img.decode(); return img; };

// Keep the painted eye and move the lid over it. Gaze warps the interior with
// pinned corners; the pupil and highlights retain their shape during blinking.
function paintEye(model, side, region, imageData, scale) {
  const iris = model.layers.find(layer => layer.name === `${side} Iris`);
  const opening = model.layers.find(layer => layer.name === `${side} Eye Opening`);
  opening.maskOnly = true;
  const lashes = model.layers.find(layer => layer.name === `${side} Eyelashes`);
  const c = canvas(region.width, region.height), ctx = c.getContext("2d");
  const pixels = ctx.createImageData(c.width, c.height);
  for (let y = 0; y < c.height; y += 1) for (let x = 0; x < c.width; x += 1) {
    const sx = region.x + x, sy = region.y + y, at = (sy * imageData.width + sx) * 4;
    const out = (y * c.width + x) * 4;
    // The stencil owns the outline. Cutting the bitmap to that outline as
    // well makes its filtered alpha leave a dark fringe around the eye.
    pixels.data.set(imageData.data.subarray(at, at + 4), out);
  }
  ctx.putImageData(pixels, 0, 0);
  const replacement = createLayer({ name: iris.name, src: c.toDataURL(), width: region.width * scale,
    height: region.height * scale, x: opening.transform.x, y: opening.transform.y, zIndex: iris.zIndex, columns: 16, rows: 10 });
  // Keep the clipping relationship and expression channels, but author gaze
  // against the full eye rather than translating a tiny, off-centre iris crop.
  const expressions = Object.fromEntries(Object.entries(iris.keyforms).filter(([id]) => id.startsWith("expr.")));
  Object.assign(iris, replacement, { id: iris.id, parent: iris.parent, clipMask: opening.id });
  for (const [id, keys] of Object.entries(expressions)) for (const key of keys) {
    Object.assign(ensureKeyform(iris, id, key.value).transform, key.transform);
  }
  for (const d of [-1, 1]) {
    warp(iris, "eyes.lookX", d, (x, y, u, v) => [d * region.width * scale * .13 * Math.sin(Math.PI * u) ** 2 * Math.sin(Math.PI * v), 0]);
    warp(iris, "eyes.lookY", d, (x, y, u, v) => [0, d * region.height * scale * .12 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v) ** 2]);
  }
  const aperture = sampleEyeAperture(side);
  const band = { height: 32, baseline: 28 };
  const lashCanvas = canvas(region.width, band.height), lashContext = lashCanvas.getContext("2d");
  const lashPixels = lashContext.createImageData(lashCanvas.width, lashCanvas.height);
  for (let y = 0; y < lashCanvas.height; y += 1) for (let x = 0; x < lashCanvas.width; x += 1) {
    const sx = region.x + x;
    const profile = sampleLidProfile(aperture, (sx - aperture.x) / aperture.width);
    const sy = profile.upper + y - band.baseline;
    if (sy > profile.upper + 1 || !regionContains(region, sx, sy)) continue;
    const at = (Math.floor(sy) * imageData.width + sx) * 4, fraction = sy - Math.floor(sy);
    const [red, green, blue, alpha] = Array.from({ length: 4 }, (_, channel) =>
      imageData.data[at + channel] * (1 - fraction) + imageData.data[at + imageData.width * 4 + channel] * fraction);
    const ink = clamp((220 - Math.max(red, green, blue)) / 40)
      * clamp((red - blue * .95 + 5) / 6) * clamp((red * .9 - green) / 15);
    const out = (y * lashCanvas.width + x) * 4;
    lashPixels.data.set([red, green, blue, alpha * ink], out);
  }
  lashContext.putImageData(lashPixels, 0, 0);
  lashes.source.src = lashCanvas.toDataURL();
  authorSampleBlink(opening, iris, lashes, aperture, region, scale, band);
}

export async function finishSampleRig(model, imageData, analysis) {
  const { subject } = analysis, { width: w, height: h } = imageData;
  const scale = Math.min(900 / subject.height, 840 / subject.width);
  const origin = { x: subject.x + subject.width / 2, y: subject.y + subject.height / 2 };
  const parts = model.layers.filter(layer => ["Torso", "Face", "Bangs", "Left Hair", "Right Hair", "Back Hair"].includes(layer.name));
  const coverage = new Float32Array(w * h);
  const eyes = [model.meta.regions.leftEye, model.meta.regions.rightEye];
  const sampledSkin = eyes.map(region => Array.from({ length: region.width + 1 }, (_, column) => {
    const x = region.x + column, profile = eyeProfile(region, column / region.width);
    const sample = (y, direction) => {
      for (const pad of [3, 6, 9, 12, 18]) for (const dx of [0, -3, 3, -6, 6]) {
        const at = (Math.round(y + direction * pad) * w + x + dx) * 4;
        const [r, g, b] = imageData.data.subarray(at, at + 3);
        if (r > 180 && g > 150 && r > g * 1.04 && g > b * .98 && r > b * 1.04) return [r, g, b];
      }
      return null;
    };
    return { ...profile, above: sample(profile.upper, -1), below: sample(profile.lower, 1) };
  }));
  // Adjacent columns may find skin at different distances from a lash. Smooth
  // those samples horizontally so the closed lid does not reveal vertical bands.
  const skinColumns = sampledSkin.map(columns => columns.map((column, index) => {
    const average = (side) => {
      const sum = [0, 0, 0]; let total = 0;
      for (let dx = -12; dx <= 12; dx += 1) {
        const color = columns[Math.max(0, Math.min(columns.length - 1, index + dx))][side];
        if (!color) continue;
        const weight = Math.exp(-((dx / 6) ** 2));
        for (let channel = 0; channel < 3; channel += 1) sum[channel] += color[channel] * weight;
        total += weight;
      }
      return total ? sum.map(value => value / total) : null;
    };
    return { ...column, above: average("above"), below: average("below") };
  }));
  for (const part of parts) {
    const img = await decode(part.source.src), c = canvas(img.width, img.height), ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, c.width, c.height);
    const x0 = Math.round(origin.x + (part.transform.x - part.source.width / 2) / scale);
    const y0 = Math.round(origin.y + (part.transform.y - part.source.height / 2) / scale);
    for (let y = 0; y < c.height; y += 1) for (let x = 0; x < c.width; x += 1) {
      const sx = x0 + x, sy = y0 + y;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const at = sy * w + sx, out = (y * c.width + x) * 4;
      const alpha = Math.min(pixels.data[out + 3], imageData.data[at * 4 + 3], analysis.mask[at]);
      pixels.data[out + 3] = alpha;
      coverage[at] = 1 - (1 - coverage[at]) * (1 - alpha / 255);
      // Retain the reconstructed skin only underneath the moving features.
      const feature = part.name === "Face" && [model.meta.regions.leftEye, model.meta.regions.rightEye, model.meta.regions.mouth]
        .some(region => regionContains(region, sx, sy));
      if (!feature) for (let channel = 0; channel < 3; channel += 1) pixels.data[out + channel] = imageData.data[at * 4 + channel];
      else for (const [index, region] of eyes.entries()) if (regionContains(region, sx, sy)) {
        // Sample outside the painted eye, never its pink highlights. Leaving
        // those warm pixels in the skin creates confetti during a full blink.
        const column = skinColumns[index][sx - region.x];
        const above = column.above ?? column.below, below = column.below ?? column.above;
        if (above && below) {
          const t = clamp((sy - column.upper) / Math.max(1, column.lower - column.upper));
          for (let channel = 0; channel < 3; channel += 1) pixels.data[out + channel] = above[channel] * (1 - t) + below[channel] * t;
        }
      }
    }
    ctx.putImageData(pixels, 0, 0);
    part.source.src = c.toDataURL();
  }
  // Feathering and island cleanup leave small holes (notably the pink hair
  // clip). Back those seams with the exact source paint on the shared cage.
  const backingCanvas = canvas(w, h), ctx = backingCanvas.getContext("2d"), pixels = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i += 1) {
    pixels.data.set(imageData.data.subarray(i * 4, i * 4 + 3), i * 4);
    pixels.data[i * 4 + 3] = coverage[i] < .995 ? Math.min(imageData.data[i * 4 + 3], analysis.mask[i]) : 0;
  }
  ctx.putImageData(pixels, 0, 0);
  const backing = createLayer({ name: "Portrait Seam Backing", src: backingCanvas.toDataURL(), width: w * scale,
    height: h * scale, x: (w / 2 - origin.x) * scale, y: (h / 2 - origin.y) * scale, zIndex: -2, columns: 18, rows: 26 });
  bindParent(backing, model.layers.find(layer => layer.name === "Portrait Deformer"));
  model.layers.push(backing);
  paintEye(model, "Left", model.meta.regions.leftEye, imageData, scale);
  paintEye(model, "Right", model.meta.regions.rightEye, imageData, scale);
  for (const [side, x, y] of [["Left", 333, 268], ["Right", 444, 255]]) {
    const stars = model.layers.find(layer => layer.name === `${side} Eye Stars`);
    stars.transform.x = (x - origin.x) * scale;
    stars.transform.y = (y - origin.y) * scale;
  }
  authorSampleMotion(model, subject);
  model.meta.rigRevision = 4;
  model.meta.autoRig.landmarkMethod = "Reviewed Kokoro-chan outlines";
  model.meta.autoRig.warnings = ["Single-image separation and hidden seams are approximations. Inspect large turns."];
  return model;
}
