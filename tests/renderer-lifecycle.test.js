import test from "node:test";
import assert from "node:assert/strict";
import { KokoroRenderer } from "../src/renderer.js";
import { createModel, createLayer } from "../src/model.js";

function fixture(name = "Fixture") {
  const model = createModel(name);
  model.layers.push(createLayer({ name: "Paint", src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==", width: 32, height: 32 }));
  model.layers.push({ ...structuredClone(model.layers[0]), id: "shared" });
  return model;
}

function setup() {
  let id = 0;
  const live = new Map(), calls = new Map();
  const canvas = new EventTarget();
  Object.assign(canvas, { width: 100, height: 100, clientWidth: 100, clientHeight: 100 });
  const state = { lost: false, fail: null, error: 0 };
  const constants = new Map([['NO_ERROR', 0], ['FRAMEBUFFER_COMPLETE', 123]]);
  const gl = new Proxy({ canvas }, { get(target, key) {
    if (key in target) return target[key];
    if (/^[A-Z0-9_]+$/.test(key)) {
      if (!constants.has(key)) constants.set(key, 200 + constants.size);
      return constants.get(key);
    }
    return (...args) => {
      calls.set(key, (calls.get(key) ?? 0) + 1);
      if (state.fail?.method === key && --state.fail.after === 0) {
        const mode = state.fail.mode;
        state.fail = null;
        if (mode === "throw") throw new Error(`Injected ${key} failure`);
        if (mode === "gl") { state.error = 1285; return; }
        return null;
      }
      if (key.startsWith("create")) { const value = { id: ++id, type: key.slice(6) }; live.set(value, value.type); return value; }
      if (key.startsWith("delete")) { assert.ok(live.delete(args[0]), `double delete: ${key}`); return; }
      if (key === "isContextLost") return state.lost;
      if (key === "getError") { const error = state.error; state.error = 0; return error; }
      if (key === "getParameter") return 8192;
      if (key === "getShaderParameter" || key === "getProgramParameter") return true;
      if (key === "getAttribLocation") return args[1] === "a_position" ? 0 : 1;
      if (key === "getUniformLocation") return {};
      if (key === "checkFramebufferStatus") return 123;
    };
  } });
  canvas.getContext = () => gl;
  globalThis.window = { devicePixelRatio: 1 };
  const images = [];
  globalThis.Image = class {
    width = 32;
    height = 32;
    set src(value) {
      this.url = value;
      if (!value) return;
      images.push(this);
      if (value.includes("pending")) return;
      queueMicrotask(() => value.includes("bad") ? this.onerror?.() : this.onload?.());
    }
  };
  const dependencies = {
    readImage: async src => ({ src, bytes: new Uint8Array(1), width: 32, height: 32 }),
    decodeImage: (artwork, { signal }) => new Promise((resolve, reject) => {
      const image = new Image();
      const abort = () => { image.onload = image.onerror = null; image.src = ""; reject(new DOMException("Cancelled", "AbortError")); };
      signal.addEventListener("abort", abort, { once: true });
      image.onload = () => { signal.removeEventListener("abort", abort); resolve(image); };
      image.onerror = () => { signal.removeEventListener("abort", abort); reject(new Error("Unable to decode artwork")); };
      if (signal.aborted) abort(); else image.src = artwork.src;
    }),
  };
  return { canvas, gl, state, live, calls, images, dependencies,
    fail(method, after = 1, mode = "null") { state.fail = { method, after, mode }; },
    lose() { state.lost = true; const event = new Event("webglcontextlost", { cancelable: true }); canvas.dispatchEvent(event); assert.ok(event.defaultPrevented); },
    restore() { state.lost = false; canvas.dispatchEvent(new Event("webglcontextrestored")); },
  };
}

for (const [method, mode] of [["createVertexArray", "null"], ["createBuffer", "null"], ["createTexture", "null"], ["bufferData", "throw"], ["bufferData", "gl"], ["texImage2D", "throw"], ["texImage2D", "gl"]]) {
  test(`failed ${method} (${mode}) rolls back without touching the active GPU set`, async () => {
    const env = setup(), renderer = new KokoroRenderer(env.canvas, env.dependencies);
    const original = fixture(); await renderer.setModel(original);
    const resources = renderer.resources, handles = [...env.live.keys()];
    env.fail(method, method === "createBuffer" ? 5 : 1, mode);
    await assert.rejects(renderer.setModel(fixture("Replacement")));
    assert.equal(renderer.model, original); assert.equal(renderer.resources, resources);
    assert.deepEqual([...env.live.keys()], handles);
    renderer.render({ "eyes.blink": .5 });
    renderer.dispose(); assert.equal(env.live.size, 0);
  });
}

test("validation, decoding, cancellation and superseded loads preserve the committed model", async () => {
  const env = setup(), renderer = new KokoroRenderer(env.canvas, env.dependencies), original = fixture();
  await renderer.setModel(original);
  await assert.rejects(renderer.setModel({}));
  const bad = fixture(); bad.layers[0].source.src = "bad";
  await assert.rejects(renderer.setModel(bad), /decode/);
  const slow = fixture(); slow.layers[0].source.src = "pending";
  const abort = new AbortController();
  const pending = renderer.setModel(slow, { signal: abort.signal });
  const rejection = assert.rejects(pending, { name: "AbortError" }); abort.abort(); await rejection;
  assert.equal(renderer.model, original);
  const stale = assert.rejects(renderer.setModel(slow), { name: "AbortError" });
  const next = fixture("Latest"); await renderer.setModel(next); await stale;
  assert.equal(renderer.model, next);
  assert.ok(env.images.filter(image => image.url === "pending").every(image => image.onload === null));
  renderer.dispose(); assert.equal(env.live.size, 0);
});

test("100 replacements share source textures and release every old handle", async () => {
  const env = setup(), renderer = new KokoroRenderer(env.canvas, env.dependencies);
  for (let i = 0; i < 100; i++) {
    await renderer.setModel(fixture());
    assert.equal(renderer.textures.size, 1);
    assert.equal(env.live.size, 11); // 2 programs, 2 VAOs, 6 buffers, 1 texture.
    assert.equal(renderer.metrics.textureBytes, 32 * 32 * 4);
  }
  renderer.dispose(); renderer.dispose(); assert.equal(env.live.size, 0);
});

for (const method of ["createProgram", "createShader", "getShaderParameter", "getProgramParameter"]) {
  test(`${method} failure during shader initialization releases partial programs`, () => {
    const env = setup(); env.fail(method, 2);
    assert.throws(() => new KokoroRenderer(env.canvas, env.dependencies)); assert.equal(env.live.size, 0);
  });
}

test("loss cancels a load, pauses GPU calls and restores model, pose and camera", async () => {
  const env = setup(), renderer = new KokoroRenderer(env.canvas, env.dependencies), model = fixture();
  await renderer.setModel(model); renderer.camera.zoom = 1.25;
  renderer.render({ "eyes.blink": .4 });
  const slow = fixture(); slow.layers[0].source.src = "pending";
  const pending = assert.rejects(renderer.setModel(slow), { name: "AbortError" });
  env.lose(); await pending;
  const calls = env.calls.get("drawElements"); renderer.render({ "eyes.blink": .7 });
  assert.equal(env.calls.get("drawElements"), calls); assert.equal(env.live.size, 0);
  env.restore(); assert.equal(renderer.available, true); assert.equal(renderer.model, model);
  assert.equal(renderer.camera.zoom, 1.25); assert.equal(renderer.parameters["eyes.blink"], .7);
  renderer.render(); assert.ok(env.calls.get("drawElements") > calls);
  for (let i = 0; i < 3; i++) { env.lose(); env.restore(); renderer.render(); }
  renderer.dispose(); assert.equal(env.live.size, 0);
});

test("recovery failure releases resources, reports error and supports retry", async () => {
  const env = setup(), renderer = new KokoroRenderer(env.canvas, env.dependencies), model = fixture();
  await renderer.setModel(model);
  let errors = 0; renderer.addEventListener("recoveryerror", () => errors++);
  env.lose(); env.fail("texImage2D", 1, "gl"); env.restore();
  assert.equal(renderer.state, "error"); assert.equal(errors, 1); assert.equal(env.live.size, 0);
  assert.equal(renderer.model, model); assert.equal(renderer.restore(), true);
  const handles = [...env.live.keys()]; assert.equal(renderer.restore(), true);
  assert.deepEqual([...env.live.keys()], handles); // Retrying a healthy renderer is a no-op.
  renderer.dispose(); env.restore(); assert.equal(env.live.size, 0);
});

for (const method of ["createFramebuffer", "createRenderbuffer", "checkFramebufferStatus", "texImage2D"]) {
  test(`compositing ${method} failure cleans up partial targets and allows retry`, async () => {
    const env = setup(), renderer = new KokoroRenderer(env.canvas, env.dependencies);
    await renderer.setModel(fixture()); const count = env.live.size;
    env.fail(method, 1, method === "texImage2D" ? "gl" : "null");
    assert.throws(() => renderer.render()); assert.equal(env.live.size, count);
    renderer.render(); env.canvas.clientWidth = 200; renderer.render();
    renderer.dispose(); assert.equal(env.live.size, 0);
  });
}
