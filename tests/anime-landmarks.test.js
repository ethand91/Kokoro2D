import test from "node:test";
import assert from "node:assert/strict";
import { applyAnimeLandmarks } from "../src/anime-landmarks.js";
import { defaultRegions, fitRegions, validateRegions } from "../src/layered-rig.js";
import { addRegionContours } from "../src/region-geometry.js";

function detection() {
  const points = [
    [20, 55], [30, 80], [60, 100], [90, 80], [100, 55],
    [28, 35], [38, 32], [48, 35], [72, 35], [82, 32], [92, 35],
    [28, 50], [38, 45], [48, 50], [30, 60], [38, 63], [46, 60],
    [72, 50], [82, 45], [92, 50], [74, 60], [82, 63], [90, 60],
    [60, 70], [50, 80], [60, 86], [70, 80], [60, 87],
  ];
  return { width: 120, height: 140, faces: [{ bbox: [15, 20, 105, 105, .99], keypoints: points.map(p => [...p, .9]) }] };
}
function estimated() {
  const feature = { x: 10, y: 10, width: 10, height: 10, confidence: .2 };
  return { extraction: .8, mask: new Uint8Array(120 * 140), subject: { x: 5, y: 5, width: 110, height: 130 },
    features: { leftEye: feature, rightEye: feature, mouth: feature },
    warnings: ["Background removal was uncertain; inspect the silhouette.", "No neck was found, so the face may include the body.", "Mouth placement was estimated; inspect lip sync."] };
}

test("28-point landmarks form valid eye perimeters and preserve a closed smile", () => {
  const base = estimated();
  const a = applyAnimeLandmarks(base, detection(), 120, 140);
  assert.equal(a.mask, base.mask);
  assert.equal(a.features.mouth.sourceClosed, true);
  assert.deepEqual(a.features.leftEye.contour[3], [46, 60]);
  assert.equal(a.features.mouth.contour.length, 16);
  assert.equal(a.face.y + a.face.height, 100);
  const regions = addRegionContours(fitRegions(defaultRegions(a), 120, 140));
  assert.deepEqual(regions.face.contour, a.face.contour);
  assert.ok(validateRegions(regions, 120, 140));
  assert.ok(validateRegions(regions, 120, 140, { faceOnly: true }));
  assert.deepEqual(a.warnings, [base.warnings[0]]);
  assert.ok(a.confidence <= .8);
});

test("weak features retain their estimate and warn without discarding good eyes", () => {
  const result = detection();result.faces[0].keypoints[25][2] = .1;
  const base = estimated();const a = applyAnimeLandmarks(base, result, 120, 140);
  assert.equal(a.features.mouth, base.features.mouth);
  assert.notEqual(a.features.leftEye, base.features.leftEye);
  assert.match(a.warnings.join(' '), /mouth landmarks were uncertain/);
  assert.equal(a.confidence, .2);
});

test("no face, invalid coordinates, and dimension mismatches cannot replace the rig", () => {
  for (const change of [r => r.faces = [], r => r.width = 60,
    r => r.faces[0].keypoints[0][0] = NaN, r => r.faces[0].keypoints[0][0] = 999,
    r => r.faces[0].keypoints.pop()]) {
    const result = detection();change(result);
    assert.throws(() => applyAnimeLandmarks(estimated(), result, 120, 140));
  }
});

test("open lips remain open and a flat closed line gets editable height", () => {
  const open = detection();open.faces[0].keypoints[27][1] = 95;
  assert.ok(!applyAnimeLandmarks(estimated(), open, 120, 140).features.mouth.sourceClosed);
  const flat = detection();for (let i = 24; i < 28; i++) flat.faces[0].keypoints[i][1] = 80;
  const a = applyAnimeLandmarks(estimated(), flat, 120, 140);
  assert.equal(a.features.mouth.sourceClosed, true);
  assert.ok(validateRegions(addRegionContours(fitRegions(defaultRegions(a), 120, 140)), 120, 140));
});
