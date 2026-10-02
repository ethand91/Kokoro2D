import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeImageData,
  estimateFeatures,
  extractSubjectMask,
  maskBounds,
  PROPORTIONS,
} from "../src/auto-rigger.js";

function image(width, height, color = [250, 250, 250, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(color, offset);
  return { width, height, data };
}

function rectangle(imageData, x, y, width, height, color) {
  for (let pixelY = y; pixelY < y + height; pixelY += 1) {
    for (let pixelX = x; pixelX < x + width; pixelX += 1) {
      imageData.data.set(color, (pixelY * imageData.width + pixelX) * 4);
    }
  }
}

function syntheticAnimePortrait() {
  const result = image(120, 160);
  rectangle(result, 30, 14, 60, 140, [93, 53, 142, 255]);
  rectangle(result, 38, 34, 44, 58, [246, 202, 190, 255]);
  rectangle(result, 43, 52, 12, 6, [40, 24, 62, 255]);
  rectangle(result, 65, 52, 12, 6, [40, 24, 62, 255]);
  rectangle(result, 54, 75, 12, 5, [174, 56, 91, 255]);
  rectangle(result, 35, 95, 50, 59, [209, 91, 174, 255]);
  return result;
}

test("uses existing transparency when artwork already has alpha", () => {
  const input = image(20, 20, [0, 0, 0, 0]);
  rectangle(input, 5, 4, 10, 13, [220, 120, 180, 255]);
  const extraction = extractSubjectMask(input);
  assert.equal(extraction.mode, "existing transparency");
  assert.deepEqual(maskBounds(extraction.mask, 20, 20), { x: 5, y: 4, width: 10, height: 13 });
});

test("extracts a foreground connected against a flat border", () => {
  const input = syntheticAnimePortrait();
  const extraction = extractSubjectMask(input);
  const bounds = maskBounds(extraction.mask, input.width, input.height);
  assert.equal(extraction.mode, "border background extraction");
  assert.ok(bounds.x >= 28 && bounds.x <= 31);
  assert.ok(bounds.width >= 60 && bounds.width <= 64);
  assert.ok(bounds.height >= 140);
});

test("estimates face and features for a stylized portrait", () => {
  const input = syntheticAnimePortrait();
  const analysis = analyzeImageData(input);
  const faceCenter = analysis.face.x + analysis.face.width / 2;
  assert.ok(Math.abs(faceCenter - 60) < 8);
  assert.ok(analysis.face.y < 55);
  assert.ok(analysis.features.leftEye.x < analysis.features.rightEye.x);
  assert.ok(analysis.features.mouth.y > analysis.features.leftEye.y);
  assert.ok(analysis.confidence > 0.4);
});

test("preserves anime clothing and skin that reach the bottom border", () => {
  for (const color of [[35, 35, 45, 255], [160, 125, 200, 255], [246, 202, 190, 255], [225, 225, 230, 255]]) {
    const input = syntheticAnimePortrait();
    rectangle(input, 25, 95, 70, 65, color);
    const extraction = extractSubjectMask(input);
    assert.equal(extraction.mode, "border background extraction");
    for (let y = 100; y < 160; y += 1) {
      assert.equal(extraction.mask[y * 120 + 60], 255, `body lost at row ${y}, color ${color}`);
    }
    assert.equal(extraction.mask[5 * 120 + 5], 0, "background should still be removed");
  }
});

test("retains the image with low confidence when border colors are ambiguous", () => {
  const input = syntheticAnimePortrait();
  rectangle(input, 0, 95, 120, 65, [35, 35, 45, 255]);
  const extraction = extractSubjectMask(input);
  assert.equal(extraction.mode, "full image fallback");
  assert.ok(extraction.confidence < 0.45);
  assert.ok(extraction.mask.every(alpha => alpha === 255));
});

// The failure this guards: exposed skin joins the face to the body through the
// neck, so the largest skin component is the whole character and the "face"
// box swallows it. Real artwork does this constantly.
function portraitWithBareShoulders() {
  const result = image(120, 200);
  rectangle(result, 30, 14, 60, 90, [93, 53, 142, 255]);   // hair
  rectangle(result, 38, 34, 44, 58, [246, 202, 190, 255]); // face
  rectangle(result, 43, 56, 12, 8, [40, 24, 62, 255]);     // eyes
  rectangle(result, 65, 56, 12, 8, [40, 24, 62, 255]);
  rectangle(result, 54, 78, 12, 5, [174, 56, 91, 255]);    // mouth
  rectangle(result, 53, 92, 14, 12, [246, 202, 190, 255]); // neck
  rectangle(result, 25, 104, 70, 80, [246, 202, 190, 255]); // bare chest
  return result;
}

test("keeps pale skin when the background is white", () => {
  const input = image(80, 80);
  rectangle(input, 20, 18, 40, 46, [246, 202, 190, 255]);
  const extraction = extractSubjectMask(input);
  // Pale skin is ~42 units from white, inside the background tolerance.
  assert.equal(extraction.mode, "border background extraction");
  // Softening the mask feathers one pixel outward, so allow the halo.
  const bounds = maskBounds(extraction.mask, 80, 80);
  assert.ok(Math.abs(bounds.x - 20) <= 1 && Math.abs(bounds.y - 18) <= 1, JSON.stringify(bounds));
  assert.ok(Math.abs(bounds.width - 40) <= 2 && Math.abs(bounds.height - 46) <= 2, JSON.stringify(bounds));
});

test("isolates the head from a body of exposed skin", () => {
  const input = portraitWithBareShoulders();
  const analysis = analyzeImageData(input);
  const face = analysis.face;
  assert.ok(face.method.startsWith("head isolated above the neck"), face.method);
  // The head is 58px of a 170px subject. Before the neck cut this box covered
  // everything down to the waist.
  assert.ok(face.height < 90, `face height ${face.height}`);
  assert.ok(face.y + face.height < 112, `face bottom ${face.y + face.height}`);
  assert.ok(Math.abs(face.x + face.width / 2 - 60) < 8);
  assert.ok(analysis.features.leftEye.x < analysis.features.rightEye.x);
  assert.ok(analysis.features.mouth.y > analysis.features.leftEye.y);
  // Anime proportions: a mouth is a fraction of the face, not a third of it.
  assert.ok(analysis.features.mouth.width < face.width * 0.25);
});

test("a face box covering the whole figure is not reported as confident", () => {
  const input = image(120, 200);
  // No hair and no neck: one skin slab, which nothing can segment into a head.
  rectangle(input, 25, 20, 70, 170, [246, 202, 190, 255]);
  const analysis = analyzeImageData(input);
  // Assert the composite, which is the number a user sees and the one the
  // placement review is judged against; the face term alone is a component.
  assert.ok(analysis.confidence < 0.35, `composite confidence ${analysis.confidence}`);
  assert.ok(analysis.warnings.length > 0, "a figure with no findable features should warn");
});

// The other half of the exposed-skin problem: a choker or collar cuts the face
// off from the body, so they are separate regions and the bare chest is simply
// the bigger one. Ranking skin regions by pixel count put the face on the chest.
function portraitWithChokerAndBareChest() {
  const result = image(140, 220);
  rectangle(result, 35, 10, 70, 95, [93, 53, 142, 255]);    // hair
  rectangle(result, 48, 30, 44, 58, [246, 202, 190, 255]);  // face, enclosed by hair
  rectangle(result, 53, 52, 12, 8, [40, 24, 62, 255]);      // eyes
  rectangle(result, 75, 52, 12, 8, [40, 24, 62, 255]);
  rectangle(result, 64, 74, 12, 5, [174, 56, 91, 255]);     // mouth
  rectangle(result, 55, 88, 30, 8, [40, 24, 62, 255]);      // choker, severing the neck
  rectangle(result, 25, 96, 90, 100, [246, 202, 190, 255]); // bare chest, 3.5x the face
  return result;
}

test("prefers the head over a larger disconnected area of bare skin", () => {
  const input = portraitWithChokerAndBareChest();
  const analysis = analyzeImageData(input);
  const face = analysis.face;
  // The chest starts at y 96. Anything at or below that is the wrong region.
  assert.ok(face.y + face.height < 100, `face reached y ${face.y + face.height}`);
  assert.ok(face.y > 10, `face starts at y ${face.y}`);
  assert.ok(Math.abs(face.x + face.width / 2 - 70) < 12, `face centre x ${face.x + face.width / 2}`);
  // Features must land on the face, not on the body below it.
  for (const feature of [analysis.features.leftEye, analysis.features.rightEye, analysis.features.mouth]) {
    assert.ok(feature.y + feature.height < 100, `feature reached y ${feature.y + feature.height}`);
  }
});

test("proportions presets change the ratios, and an unknown one falls back", () => {
  assert.deepEqual(Object.keys(PROPORTIONS), ["anime", "realistic"]);
  const input = portraitWithBareShoulders();
  const anime = analyzeImageData(input, "anime");
  const realistic = analyzeImageData(input, "realistic");
  assert.equal(anime.style, "anime");
  assert.equal(realistic.style, "realistic");
  assert.equal(analyzeImageData(input, "nonsense").style, "anime");
  assert.deepEqual(analyzeImageData(input).features, anime.features);

  // A realistic face is drawn with much smaller eyes and a wider mouth sitting
  // further below them. If these stop differing the presets have stopped doing
  // anything, which is the failure that would go unnoticed.
  assert.ok(realistic.features.leftEye.height < anime.features.leftEye.height * 0.8,
    `${realistic.features.leftEye.height} vs ${anime.features.leftEye.height}`);
  assert.ok(realistic.features.mouth.width > anime.features.mouth.width * 1.4,
    `${realistic.features.mouth.width} vs ${anime.features.mouth.width}`);
  // Search priors differ, but detected mouths may converge on the same ink.
  assert.ok(PROPORTIONS.realistic.mouthDrop > PROPORTIONS.anime.mouthDrop);

  // Both must still produce a usable rig: features on the face, eyes above mouth.
  for (const analysis of [anime, realistic]) {
    assert.ok(analysis.features.leftEye.x < analysis.features.rightEye.x);
    assert.ok(analysis.features.mouth.y > analysis.features.leftEye.y);
    for (const part of ["leftEye", "rightEye", "mouth"]) {
      const r = analysis.features[part];
      assert.ok(r.x >= analysis.face.x - 12 && r.y >= analysis.face.y - 12, `${part} left the face`);
    }
  }
});

test("confidence answers to detail and to the eyes agreeing", () => {
  const sharp = portraitWithBareShoulders();
  const crisp = analyzeImageData(sharp);
  assert.ok(crisp.sharpness > 10, `sharpness ${crisp.sharpness}`);
  assert.ok(crisp.agreement > 0.8, `agreement ${crisp.agreement}`);

  // Blur the picture. A person can still see the features, but the detail the
  // search depends on is gone, and confidence has to fall with it. Measured
  // over 30 variants, a five pixel blur used to leave confidence at 0.73 while
  // the result fell to 0.39.
  const blurred = image(sharp.width, sharp.height);
  const radius = 3;
  for (let y = 0; y < sharp.height; y += 1) {
    for (let x = 0; x < sharp.width; x += 1) {
      const sums = [0, 0, 0, 0];
      let n = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sx = Math.min(sharp.width - 1, Math.max(0, x + dx));
          const sy = Math.min(sharp.height - 1, Math.max(0, y + dy));
          const offset = (sy * sharp.width + sx) * 4;
          for (let c = 0; c < 4; c += 1) sums[c] += sharp.data[offset + c];
          n += 1;
        }
      }
      const target = (y * sharp.width + x) * 4;
      for (let c = 0; c < 4; c += 1) blurred.data[target + c] = sums[c] / n;
    }
  }
  const soft = analyzeImageData(blurred);
  assert.ok(soft.sharpness < crisp.sharpness * 0.75, `${soft.sharpness} vs ${crisp.sharpness}`);
  assert.ok(soft.confidence < crisp.confidence, `${soft.confidence} vs ${crisp.confidence}`);

  // A featureless slab has nothing to agree about and must not read confident.
  const slab = image(120, 200);
  rectangle(slab, 25, 20, 70, 170, [246, 202, 190, 255]);
  assert.ok(analyzeImageData(slab).confidence < 0.45, "a blank figure should not be confident");

  // Confidence must not be a measure of how much ink a feature is drawn with.
  // A faintly drawn mouth that is found unambiguously should not be scored at
  // the floor: that is what kept a correct realistic portrait under-read.
  const faint = portraitWithBareShoulders();
  rectangle(faint, 54, 74, 12, 5, [246, 202, 190, 255]);   // erase the mouth
  rectangle(faint, 54, 76, 12, 1, [188, 120, 132, 255]);   // redraw it as a line
  const drawn = analyzeImageData(faint);
  assert.ok(drawn.features.mouth.confidence > 0.2,
    `a found line-art mouth scored at the floor: ${drawn.features.mouth.confidence}`);
});

// Known feature centers, with a heavy brow/highlight above one eye and a cool
// hair stroke beside a neutral ink mouth. Also exercise scale and head tilt.
test("anime landmarks prefer a coherent eye pair and find neutral line-art lips", () => {
  for (const scale of [1, 2]) for (const tilt of [0, 5, 10]) {
    const input = image(120 * scale, 150 * scale, [246, 202, 190, 255]);
    const draw = (x, y, w, h, color) => rectangle(input, x * scale, y * scale, w * scale, h * scale, [...color, 255]);
    draw(28, 57, 18, 10, [255, 255, 255]);
    draw(32, 58, 9, 8, [35, 30, 35]);
    draw(74, 57 + tilt, 18, 10, [255, 255, 255]);
    draw(79, 58 + tilt, 9, 8, [35, 30, 35]);
    draw(24, 43, 23, 5, [25, 25, 25]);
    draw(24, 48, 23, 4, [255, 255, 255]);
    draw(56, 87, 10, 2, [45, 45, 45]);
    draw(70, 80, 3, 30, [45, 35, 65]);
    const face = { x: 10 * scale, y: 10 * scale, width: 100 * scale, height: 120 * scale };
    const features = estimateFeatures(input, new Uint8ClampedArray(input.width * input.height).fill(255), face);
    for (const [name, x, y] of [["leftEye", 36.5, 62], ["rightEye", 83.5, 62 + tilt], ["mouth", 61, 88]]) {
      const r = features[name];
      assert.ok(Math.abs((r.x + r.width / 2) / scale - x) < 6, `${name} x, scale ${scale}, tilt ${tilt}`);
      assert.ok(Math.abs((r.y + r.height / 2) / scale - y) < 3, `${name} y, scale ${scale}, tilt ${tilt}`);
      assert.ok(Number.isFinite(r.confidence) && r.confidence <= 1);
    }
  }
});

test("missing facial ink stays low-confidence rather than inventing a strong pair", () => {
  const input = image(120, 150, [246, 202, 190, 255]);
  const features = estimateFeatures(input, new Uint8ClampedArray(120 * 150).fill(255), { x: 10, y: 10, width: 100, height: 120 });
  for (const r of Object.values(features)) assert.ok(r.confidence <= 0.2);
});
