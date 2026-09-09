import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeImageData,
  extractSubjectMask,
  maskBounds,
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
