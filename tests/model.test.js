import test from "node:test";
import assert from "node:assert/strict";
import {
  createLayer,
  createModel,
  ensureKeyform,
  evaluateLayer,
  parseModel,
  serializeModel,
  validateModel,
} from "../src/model.js";
import { createSampleModel } from "../src/sample.js";

test("sample model satisfies schema", () => {
  const model = createSampleModel();
  assert.deepEqual(validateModel(model), []);
  assert.equal(model.schema, "kokoro2d");
  assert.equal(model.layers.length, 4);
  assert.equal(model.layers[0].source.src, "./static/kokoro-chan.webp");
  assert.ok(model.layers[0].mesh.vertices.length >= 1200);
  assert.ok(model.layers[1].keyforms["eyes.blink"]);
  assert.deepEqual(model.layers[3].source.crop, { x: 367, y: 310, width: 52, height: 34 });
  assert.equal(model.layers[3].source.mask, "ellipse");
  assert.ok(model.parameters["body.breathe"]);
});

test("model serialization round-trips", () => {
  const model = createSampleModel();
  const parsed = parseModel(serializeModel(model));
  assert.equal(parsed.meta.name, model.meta.name);
  assert.equal(parsed.layers.length, model.layers.length);
});

test("keyforms interpolate around the implicit default", () => {
  const model = createModel("Test");
  const layer = createLayer({ name: "Face", src: "data:image/png;base64,AA==", width: 100, height: 100 });
  model.layers.push(layer);
  const key = ensureKeyform(layer, "head.yaw", 1);
  key.transform.x = 20;
  key.offsets[0] = 10;

  const halfway = evaluateLayer(layer, { "head.yaw": 0.5 }, model.parameters);
  assert.equal(halfway.transform.x, 10);
  assert.equal(halfway.vertices[0], layer.mesh.vertices[0] + 5);

  const defaultPose = evaluateLayer(layer, { "head.yaw": 0 }, model.parameters);
  assert.equal(defaultPose.transform.x, 0);
  assert.equal(defaultPose.vertices[0], layer.mesh.vertices[0]);
});

test("parameter channels combine additively", () => {
  const model = createModel("Test");
  const layer = createLayer({ name: "Face", src: "data:image/png;base64,AA==", width: 100, height: 100 });
  model.layers.push(layer);
  ensureKeyform(layer, "head.yaw", 1).transform.x = 20;
  ensureKeyform(layer, "body.sway", 1).transform.x = 5;
  const pose = evaluateLayer(layer, { "head.yaw": 1, "body.sway": 1 }, model.parameters);
  assert.equal(pose.transform.x, 25);
});

test("validator rejects malformed triangle indices", () => {
  const model = createSampleModel();
  model.layers[0].mesh.indices.pop();
  assert.ok(validateModel(model).some((error) => error.includes("triangles")));
});
