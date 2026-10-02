import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, createModel, evaluateLayer, defaultParameterValues } from "../src/model.js";
import { sampleRegions, authorSampleMotion } from "../src/sample-rig.js";
import { authorPortraitMotion } from "../src/portrait-motion.js";
import { bindParent, evaluateScene } from "../src/scene.js";
import { validateRegions } from "../src/layered-rig.js";
import { sampleEyeAperture, sampleLidProfile, authorSampleBlink } from "../src/sample-blink.js";

function fixture() {
  const model = createModel(), subject = { x: 0, y: 0, width: 768, height: 1152 };
  model.meta.regions = sampleRegions();
  for (const id of ["body.breathe", "body.bounce"]) model.parameters[id] = { id, min: -1, max: 1, default: 0 };
  const root = createLayer({ name: "Portrait Deformer", width: 600, height: 900, columns: 18, rows: 26 });
  authorPortraitMotion(root, subject, model.meta.regions.face, subject, 900 / 1152);
  const head = createLayer({ name: "Head Deformer", width: 600, height: 650, y: -125, columns: 14, rows: 18 });
  bindParent(head, root);
  const eye = createLayer({ name: "Eye", width: 60, height: 40, x: -45, y: -242 });
  bindParent(eye, head);
  model.layers = [root, head, eye];
  authorSampleMotion(model, subject);
  return { model, root, head, eye };
}

test("reviewed sample eyes and closed smile are valid, independent outlines", () => {
  const regions = sampleRegions();
  assert.doesNotThrow(() => validateRegions(regions, 768, 1152));
  assert.equal(regions.mouth.sourceClosed, true);
  for (const name of ["leftEye", "rightEye", "mouth"]) assert.ok(regions[name].contour.length >= 10);
  regions.leftEye.contour[0][0] = 0;
  assert.equal(sampleRegions().leftEye.contour[0][0], 277);
});

test("sample lids cover stable pupils, carry opaque lashes and share a closed seam", () => {
  for (const side of ["Left", "Right"]) {
    const model = createModel(), aperture = sampleEyeAperture(side);
    const paint = sampleRegions()[side === "Left" ? "leftEye" : "rightEye"];
    const eye = createLayer({ name: `${side} Iris`, width: paint.width, height: paint.height });
    const mask = createLayer({ name: `${side} Eye Opening`, width: paint.width, height: paint.height });
    const lashes = createLayer({ name: `${side} Eyelashes`, src: "painted lashes", width: paint.width, height: 4 });
    ensureOldBlink(eye);
    authorSampleBlink(mask, eye, lashes, aperture, paint, 1);
    for (const id of ["expr.happy", "expr.sad", "expr.angry", "expr.confused"]) model.parameters[id] = { id, min: 0, max: 1, default: 0 };
    const neutral = evaluateLayer(mask, {}, model.parameters).vertices;
    for (const blink of [0, .1, .25, .5, .65, .75, .95, 1]) {
      assert.deepEqual(evaluateLayer(eye, { "eyes.blink": blink }, model.parameters).vertices, eye.mesh.vertices, "blinking must not flatten the pupil");
      assert.equal(evaluateLayer(lashes, { "eyes.blink": blink }, model.parameters).transform.opacity, 1, "lashes should not fade into a different stroke");
    }
    const halfway = evaluateLayer(mask, { "eyes.blink": .5 }, model.parameters).vertices;
    for (let column = 1; column < mask.mesh.columns; column++) {
      const top = column * 2 + 1, bottom = (mask.mesh.rows * (mask.mesh.columns + 1) + column) * 2 + 1;
      const upperTravel = halfway[top] - neutral[top], lowerTravel = neutral[bottom] - halfway[bottom];
      assert.ok(upperTravel > lowerTravel * 6, "the upper lid should do most of the work");
      assert.ok(halfway[top] < halfway[bottom], "the aperture should remain open without folding");
    }
    const values = Object.fromEntries(Object.keys(model.parameters).filter(id => id.startsWith("expr.")).map(id => [id, 1]));
    const closed = evaluateLayer(mask, { ...values, "eyes.blink": 1 }, model.parameters).vertices;
    for (let column = 0; column <= mask.mesh.columns; column++) for (let row = 1; row <= mask.mesh.rows; row++) {
      const top = column * 2 + 1, other = (row * (mask.mesh.columns + 1) + column) * 2 + 1;
      assert.ok(Math.abs(closed[top] - closed[other]) < 1e-8, "expressions must not reopen a closed mask");
    }
    const middle = sampleLidProfile(aperture, .5);
    assert.ok(middle.closed > (middle.upper + middle.lower) / 2);
  }
});

function ensureOldBlink(eye) {
  eye.keyforms["eyes.blink"] = [{ value: 1, offsets: eye.mesh.vertices.map((v, i) => i % 2 ? -v : 0), transform: {} }];
}

test("sample perspective and posture carry eye attachments without folding cages", () => {
  const { model, root, head, eye } = fixture(), defaults = defaultParameterValues(model);
  const neutral = evaluateScene(model, defaults).get(eye.id).vertices;
  for (const yaw of [-1, 0, 1]) for (const pitch of [-1, 1]) for (const roll of [-1, 1]) for (const sway of [-1, 1]) for (const bounce of [-1, 1]) {
    const values = { ...defaults, "head.yaw": yaw, "head.pitch": pitch, "head.roll": roll, "body.sway": sway, "body.bounce": bounce };
    const scene = evaluateScene(model, values);
    assert.ok(scene.get(eye.id).vertices.some((v, i) => Math.abs(v - neutral[i]) > 1));
    for (const layer of [root, head, eye]) {
      const posed = scene.get(layer.id).vertices;
      for (let i = 0; i < layer.mesh.indices.length; i += 3) {
        const [a, b, c] = layer.mesh.indices.slice(i, i + 3).map(v => v * 2);
        const area = v => (v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[b + 1] - v[a + 1]) * (v[c] - v[a]);
        assert.ok(area(posed) * area(layer.mesh.vertices) > 0, `${layer.name} folded`);
      }
    }
  }
  const bounced = evaluateLayer(root, { "body.bounce": 1 }, model.parameters).vertices;
  const base = root.mesh.vertices.length - 2 * (root.mesh.columns + 1);
  assert.deepEqual(bounced.slice(base), root.mesh.vertices.slice(base));
});
