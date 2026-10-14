import { evaluateScene } from "./scene.js";
import { validateModel, MODEL_LIMITS } from "./model.js";
import { readArtwork, decodeArtwork } from "./texture-source.js";

const VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 a_position;
in vec2 a_uv;
uniform vec2 u_resolution;
uniform vec2 u_translation;
uniform vec2 u_scale;
uniform vec2 u_camera;
uniform float u_rotation;
uniform float u_zoom;
out vec2 v_uv;
void main() {
  float c = cos(u_rotation);
  float s = sin(u_rotation);
  vec2 scaled = a_position * u_scale;
  vec2 world = vec2(c * scaled.x - s * scaled.y, s * scaled.x + c * scaled.y) + u_translation;
  vec2 view = (world - u_camera) * u_zoom;
  vec2 clip = view / (u_resolution * 0.5);
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_uv;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_opacity;
uniform vec4 u_uv_rect;
uniform float u_edge_feather;
uniform float u_ellipse_mask;
uniform bool u_mask_pass;
out vec4 outColor;
void main() {
  vec2 textureUv = u_uv_rect.xy + v_uv * u_uv_rect.zw;
  vec4 color = texture(u_texture, textureUv);
  float rectangleEdge = min(min(v_uv.x, 1.0 - v_uv.x), min(v_uv.y, 1.0 - v_uv.y));
  float ellipseEdge = (1.0 - length((v_uv - 0.5) * 2.0)) * 0.5;
  float edge = mix(rectangleEdge, ellipseEdge, u_ellipse_mask);
  float featherMask = u_edge_feather > 0.0 ? smoothstep(0.0, u_edge_feather, edge) : 1.0;
  if (u_mask_pass && color.a * featherMask * u_opacity < 0.05) discard;
  float alpha = color.a * u_opacity * featherMask;
  outColor = vec4(color.rgb * alpha, alpha);
}`;

function allocate(value, label) {
  if (!value) throw new Error(`Unable to allocate WebGL ${label}.`);
  return value;
}

function shader(gl, type, source) {
  const result = allocate(gl.createShader(type), "shader");
  try {
    gl.shaderSource(result, source);
    gl.compileShader(result);
    if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(result) || "Shader compilation failed.");
    }
    return result;
  } catch (error) {
    gl.deleteShader(result);
    throw error;
  }
}

function program(gl, vertex = VERTEX_SHADER, fragment = FRAGMENT_SHADER) {
  const result = allocate(gl.createProgram(), "program");
  const shaders = [];
  try {
    shaders.push(shader(gl, gl.VERTEX_SHADER, vertex));
    shaders.push(shader(gl, gl.FRAGMENT_SHADER, fragment));
    for (const item of shaders) gl.attachShader(result, item);
    gl.linkProgram(result);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(result) || "Shader linking failed.");
    }
    return result;
  } catch (error) {
    gl.deleteProgram(result);
    throw error;
  } finally {
    for (const item of shaders) gl.deleteShader(item);
  }
}

const COMPOSITE_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  v_uv = (p + 1.0) * .5; gl_Position = vec4(p, 0.0, 1.0);
}`;
const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_backdrop;
uniform sampler2D u_source;
uniform float u_opacity;
uniform int u_mode;
uniform bool u_straight;
out vec4 outColor;
void main() {
  vec4 b = texture(u_backdrop, v_uv), s = texture(u_source, v_uv) * u_opacity;
  vec3 cb = b.a > 0.0 ? b.rgb / b.a : vec3(0.0), cs = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  vec3 blend = cs;
  if (u_mode == 1) blend = cb * cs;
  if (u_mode == 2) blend = cb + cs - cb * cs;
  if (u_mode == 3) blend = mix(2.0 * cb * cs, 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs), step(vec3(.5), cb));
  vec4 result = vec4((1.0-s.a)*b.rgb + (1.0-b.a)*s.rgb + s.a*b.a*blend, s.a+b.a-s.a*b.a);
  if (u_straight) result = vec4(s.a > 0.0 ? s.rgb / s.a : vec3(0.0), s.a);
  outColor = result;
}`;

function resourceSet() {
  return { resources: new Map(), textures: new Map(), textureBytes: 0 };
}

export class KokoroRenderer extends EventTarget {
  constructor(canvas, { readImage = readArtwork, decodeImage = decodeArtwork } = {}) {
    super();
    this.canvas = canvas;
    this.readImage = readImage;
    this.decodeImage = decodeImage;
    this.gl = canvas.getContext("webgl2", {
      alpha: true,
      stencil: true,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!this.gl) throw new Error("Kokoro2D requires WebGL2.");
    this.targets = [];
    this.textures = new Map();
    this.metrics = { frameMs: 0, textureBytes: 0, surfaceBytes: 0, drawCalls: 0, uploads: 0 };
    this.model = null;
    this.images = new Map();
    this.parameters = {};
    this.resources = new Map();
    this.camera = { x: 0, y: 0, zoom: 0.78 };
    this.state = "initializing";
    this.pendingLoad = null;
    this.#initializePrograms();
    this.state = "ready";
    this.onContextLost = (event) => {
      event.preventDefault();
      this.pendingLoad?.abort();
      this.state = "lost";
      // Lost-context handles are invalid; retain only the CPU model and images.
      this.disposeResources();
      this.#disposeTargets();
      this.#disposePrograms();
      this.dispatchEvent(new Event("contextlost"));
    };
    this.onContextRestored = () => this.restore();
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  get available() { return this.state === "ready" && !this.gl.isContextLost(); }

  #checkGL(operation) {
    if (this.gl.isContextLost()) throw new Error(`WebGL context lost during ${operation}.`);
    const error = this.gl.getError();
    if (error !== this.gl.NO_ERROR) throw new Error(`WebGL ${operation} failed (0x${error.toString(16)}).`);
  }

  #initializePrograms() {
    const gl = this.gl;
    let main, composite;
    try {
      main = program(gl);
      composite = program(gl, COMPOSITE_VERTEX, COMPOSITE_FRAGMENT);
      const locations = this.#locations(main);
      const compositeLocations = Object.fromEntries(["backdrop", "source", "opacity", "mode", "straight"].map(name => [name, gl.getUniformLocation(composite, `u_${name}`)]));
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.#checkGL("shader initialization");
      this.program = main;
      this.compositeProgram = composite;
      this.locations = locations;
      this.compositeLocations = compositeLocations;
    } catch (error) {
      if (main) gl.deleteProgram(main);
      if (composite) gl.deleteProgram(composite);
      throw error;
    }
  }

  // May also be called explicitly to retry a failed restoration.
  restore() {
    if (this.state === "disposed" || this.gl.isContextLost()) return false;
    if (this.state === "ready") return true;
    this.pendingLoad?.abort();
    this.state = "restoring";
    this.disposeResources();
    this.#disposeTargets();
    this.#disposePrograms();
    try {
      this.#initializePrograms();
      if (this.model) this.#install(this.#buildResources(this.model, this.images));
      this.state = "ready";
      this.dispatchEvent(new Event("contextrestored"));
      return true;
    } catch (error) {
      this.#disposePrograms();
      this.state = "error";
      this.dispatchEvent(new CustomEvent("recoveryerror", { detail: error }));
      return false;
    }
  }

  #locations(program) {
    const gl = this.gl;
    const getAttribute = (name) => gl.getAttribLocation(program, name);
    const getUniform = (name) => gl.getUniformLocation(program, name);
    return {
      position: getAttribute("a_position"),
      uv: getAttribute("a_uv"),
      resolution: getUniform("u_resolution"),
      translation: getUniform("u_translation"),
      scale: getUniform("u_scale"),
      camera: getUniform("u_camera"),
      rotation: getUniform("u_rotation"),
      zoom: getUniform("u_zoom"),
      opacity: getUniform("u_opacity"),
      uvRect: getUniform("u_uv_rect"),
      edgeFeather: getUniform("u_edge_feather"),
      maskPass: getUniform("u_mask_pass"),
      ellipseMask: getUniform("u_ellipse_mask"),
    };
  }

  async setModel(model, { signal } = {}) {
    if (!this.available) throw new Error("WebGL is unavailable; wait for context recovery.");
    const errors = validateModel(model);
    if (errors.length) throw new Error(errors.join("\n"));
    this.pendingLoad?.abort();
    const controller = new AbortController();
    this.pendingLoad = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new Error("Model artwork loading timed out.")), 60000);
    try {
      controller.signal.throwIfAborted();
      const sources = [...new Set(model.layers.map(layer => layer.source.src))];
      const images = new Map();
      let pixels = 0, bytes = 0;
      // Decode sequentially so hostile files cannot launch hundreds of decoders.
      for (const src of sources) {
        const artwork = await this.readImage(src, { signal: controller.signal });
        controller.signal.throwIfAborted();
        bytes += artwork.bytes.length;
        const nextPixels = artwork.width * artwork.height;
        if (bytes > MODEL_LIMITS.embeddedBytes || pixels + nextPixels > MODEL_LIMITS.texturePixels) throw new Error("Model artwork exceeds 64 MiB encoded or 64 megapixels decoded.");
        const image = await this.decodeImage(artwork, { signal: controller.signal });
        pixels += image.width * image.height;
        if (pixels > MODEL_LIMITS.texturePixels) throw new Error("Decoded model artwork exceeds 64 megapixels.");
        images.set(src, image);
      }
      controller.signal.throwIfAborted();
      if (!this.available) throw new Error("WebGL context is unavailable.");
      const next = this.#buildResources(model, images);
      // No await between building and committing: animation sees one complete set.
      const previous = { resources: this.resources, textures: this.textures };
      this.#install(next);
      this.model = model;
      this.images = images;
      this.#release(previous);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      signal?.removeEventListener("abort", abort);
      if (this.pendingLoad === controller) this.pendingLoad = null;
    }
  }

  #install(next) {
    this.resources = next.resources;
    this.textures = next.textures;
    this.metrics.textureBytes = next.textureBytes;
  }

  #buildResources(model, images) {
    const next = resourceSet();
    try {
      for (const layer of model.layers) this.#createLayerResources(layer, images.get(layer.source.src), next);
      this.#checkGL("model upload");
      return next;
    } catch (error) {
      this.#release(next);
      throw error;
    } finally {
      this.gl.bindVertexArray(null);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
      this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    }
  }

  #createLayerResources(layer, image, next) {
    const gl = this.gl;
    if (!image) throw new Error(`Missing decoded image for ${layer.name}.`);
    const crop = layer.source.crop;
    if (crop && (crop.x + crop.width > image.width + 1e-6 || crop.y + crop.height > image.height + 1e-6)) throw new Error(`Layer ${layer.name}: crop extends beyond decoded artwork.`);
    const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (!image.width || !image.height || image.width > limit || image.height > limit) {
      throw new Error(`Layer ${layer.name} exceeds this GPU's ${limit}px texture limit.`);
    }
    // Register ownership before any operation that can fail.
    const resource = {};
    next.resources.set(layer.id, resource);
    resource.vao = allocate(gl.createVertexArray(), "vertex array");
    gl.bindVertexArray(resource.vao);
    resource.positionBuffer = allocate(gl.createBuffer(), "position buffer");
    gl.bindBuffer(gl.ARRAY_BUFFER, resource.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(layer.mesh.vertices), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.locations.position);
    gl.vertexAttribPointer(this.locations.position, 2, gl.FLOAT, false, 0, 0);
    resource.uvBuffer = allocate(gl.createBuffer(), "UV buffer");
    gl.bindBuffer(gl.ARRAY_BUFFER, resource.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(layer.mesh.uvs), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.locations.uv);
    gl.vertexAttribPointer(this.locations.uv, 2, gl.FLOAT, false, 0, 0);
    resource.indexBuffer = allocate(gl.createBuffer(), "index buffer");
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resource.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(layer.mesh.indices), gl.STATIC_DRAW);
    let texture = next.textures.get(layer.source.src);
    if (!texture) {
      texture = allocate(gl.createTexture(), "texture");
      next.textures.set(layer.source.src, texture);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      next.textureBytes += image.width * image.height * 4;
    }
    this.#checkGL(`upload for ${layer.name}`);
    Object.assign(resource, {
      vertices: new Float32Array(layer.mesh.vertices.length),
      uploaded: false,
      texture,
      count: layer.mesh.indices.length,
      uvRect: crop ? [crop.x / image.width, crop.y / image.height, crop.width / image.width, crop.height / image.height] : [0, 0, 1, 1],
      edgeFeather: Math.max(0, Math.min(0.49, Number(layer.source.feather ?? 0))),
      ellipseMask: layer.source.mask === "ellipse" ? 1 : 0,
    });
  }

  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
  }

  #target() {
    const gl = this.gl, width = this.canvas.width, height = this.canvas.height;
    let target = this.targets.find(item => !item.busy && item.width === width && item.height === height);
    if (!target) {
      const pending = {};
      try {
        const texture = pending.texture = allocate(gl.createTexture(), "surface texture"); gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const framebuffer = pending.framebuffer = allocate(gl.createFramebuffer(), "framebuffer"); gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        const stencil = pending.stencil = allocate(gl.createRenderbuffer(), "stencil buffer"); gl.bindRenderbuffer(gl.RENDERBUFFER, stencil);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, width, height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, stencil);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Unable to create compositing surface.");
        this.#checkGL("compositing surface");
        target = { texture, framebuffer, stencil, width, height, busy: false }; this.targets.push(target);
      } catch (error) {
        this.#releaseTarget(pending);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        throw error;
      }
    }
    target.busy = true; gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.disable(gl.STENCIL_TEST); gl.colorMask(true, true, true, true); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return target;
  }

  render(parameters = this.parameters) {
    this.parameters = parameters;
    if (!this.model || !this.available) return;
    const start = performance.now(); this.resize();
    const gl = this.gl;
    // Resize releases old full-frame surfaces rather than retaining every size.
    for (const target of [...this.targets]) if (target.width !== this.canvas.width || target.height !== this.canvas.height) {
      gl.deleteTexture(target.texture); gl.deleteFramebuffer(target.framebuffer); gl.deleteRenderbuffer(target.stencil);
      this.targets.splice(this.targets.indexOf(target), 1);
    }
    this.metrics.drawCalls = 0; this.metrics.uploads = 0;
    const poses = evaluateScene(this.model, parameters), layers = new Map(this.model.layers.map(l => [l.id, l]));
    const draw = (layer, maskPass = false) => {
      const resources = this.resources.get(layer.id); if (!resources) return;
      const pose = poses.get(layer.id);
      gl.useProgram(this.program);
      gl.uniform2f(this.locations.resolution, gl.canvas.width, gl.canvas.height);
      gl.uniform2f(this.locations.camera, this.camera.x, this.camera.y);
      gl.uniform1f(this.locations.zoom, this.camera.zoom * (gl.canvas.width / gl.canvas.clientWidth));
      gl.uniform1i(this.locations.maskPass, maskPass); gl.bindVertexArray(resources.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.positionBuffer);
      if (!resources.uploaded || pose.vertices.some((value, i) => Math.fround(value) !== resources.vertices[i])) {
        resources.vertices.set(pose.vertices); gl.bufferSubData(gl.ARRAY_BUFFER, 0, resources.vertices);
        resources.uploaded = true; this.metrics.uploads++;
      }
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, resources.texture);
      gl.uniform2f(this.locations.translation, pose.transform.x, pose.transform.y);
      gl.uniform2f(this.locations.scale, pose.transform.scaleX, pose.transform.scaleY);
      gl.uniform1f(this.locations.rotation, pose.transform.rotation); gl.uniform1f(this.locations.opacity, pose.transform.opacity);
      gl.uniform4fv(this.locations.uvRect, resources.uvRect); gl.uniform1f(this.locations.edgeFeather, resources.edgeFeather);
      gl.uniform1f(this.locations.ellipseMask, resources.ellipseMask);
      gl.drawElements(gl.TRIANGLES, resources.count, gl.UNSIGNED_INT, 0); this.metrics.drawCalls++;
    };
    const clip = (id) => {
      gl.disable(gl.STENCIL_TEST); if (!id) return;
      const chain = [], seen = new Set();
      while (id) {
        const mask = layers.get(id); if (!mask || seen.has(id) || chain.length >= 32) throw new Error("Invalid mask chain.");
        chain.push(mask); seen.add(id); id = mask.clipMask;
      }
      gl.enable(gl.STENCIL_TEST); gl.stencilMask(0xff); gl.clearStencil(0); gl.clear(gl.STENCIL_BUFFER_BIT);
      gl.colorMask(false, false, false, false);
      chain.reverse().forEach((mask, i) => {
        gl.stencilFunc(gl.EQUAL, i, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR); draw(mask, true);
      });
      gl.colorMask(true, true, true, true); gl.stencilMask(0); gl.stencilFunc(gl.EQUAL, chain.length, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    };
    const quad = (backdrop, source, opacity = 1, mode = "normal", straight = false) => {
      gl.useProgram(this.compositeProgram); gl.bindVertexArray(null); gl.disable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, backdrop.texture);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, source.texture);
      const u = this.compositeLocations;
      gl.uniform1i(u.backdrop, 0); gl.uniform1i(u.source, 1); gl.uniform1f(u.opacity, opacity);
      gl.uniform1i(u.mode, ["normal", "multiply", "screen", "overlay"].indexOf(mode)); gl.uniform1i(u.straight, straight);
      gl.drawArrays(gl.TRIANGLES, 0, 3); this.metrics.drawCalls++;
      gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    };
    const combine = (backdrop, source, item) => {
      const output = this.#target();
      // Keep pixels outside a group mask intact.
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, backdrop.framebuffer); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, output.framebuffer);
      gl.blitFramebuffer(0, 0, this.canvas.width, this.canvas.height, 0, 0, this.canvas.width, this.canvas.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, output.framebuffer); clip(item.clipMask);
      quad(backdrop, source, item.opacity ?? 1, item.blendMode ?? "normal");
      gl.disable(gl.STENCIL_TEST); backdrop.busy = false; source.busy = false; return output;
    };
    const groups = this.model.groups ?? [];
    const children = parent => [
      ...groups.filter(g => (g.parent ?? null) === parent).map(g => ({ ...g, isGroup: true })),
      ...this.model.layers.filter(l => (l.group ?? null) === parent && l.visible && !l.maskOnly),
    ].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
    const renderGroup = parent => {
      let target = this.#target();
      for (const item of children(parent)) {
        if (item.isGroup) {
          if (item.visible === false) continue;
          target = combine(target, renderGroup(item.id), item);
        } else if (item.blendMode && item.blendMode !== "normal") {
          const source = this.#target(); clip(item.clipMask); draw(item);
          gl.disable(gl.STENCIL_TEST); target = combine(target, source, { blendMode: item.blendMode });
        } else {
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer); clip(item.clipMask); draw(item); gl.disable(gl.STENCIL_TEST);
        }
      }
      return target;
    };
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    try {
      const result = renderGroup(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.disable(gl.STENCIL_TEST); quad(result, result, 1, "normal", true);
      result.busy = false; gl.stencilMask(0xff); gl.bindVertexArray(null);
    } finally {
      for (const target of this.targets) target.busy = false;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindVertexArray(null);
      gl.colorMask(true, true, true, true);
      gl.stencilMask(0xff);
    }
    this.metrics.frameMs = performance.now() - start;
    this.metrics.surfaceBytes = this.targets.length * this.canvas.width * this.canvas.height * 8;
  }

  worldToScreen(x, y) {
    const scale = this.camera.zoom;
    return {
      x: this.canvas.clientWidth / 2 + (x - this.camera.x) * scale,
      y: this.canvas.clientHeight / 2 + (y - this.camera.y) * scale,
    };
  }

  screenToWorld(x, y) {
    const scale = this.camera.zoom;
    return {
      x: (x - this.canvas.clientWidth / 2) / scale + this.camera.x,
      y: (y - this.canvas.clientHeight / 2) / scale + this.camera.y,
    };
  }

  localToWorld(x, y, transform) {
    const scaledX = x * transform.scaleX;
    const scaledY = y * transform.scaleY;
    const cosine = Math.cos(transform.rotation);
    const sine = Math.sin(transform.rotation);
    return {
      x: cosine * scaledX - sine * scaledY + transform.x,
      y: sine * scaledX + cosine * scaledY + transform.y,
    };
  }

  worldToLocal(x, y, transform) {
    const translatedX = x - transform.x;
    const translatedY = y - transform.y;
    const cosine = Math.cos(-transform.rotation);
    const sine = Math.sin(-transform.rotation);
    return {
      x: (cosine * translatedX - sine * translatedY) / transform.scaleX,
      y: (sine * translatedX + cosine * translatedY) / transform.scaleY,
    };
  }

  #release(set) {
    for (const resource of set.resources.values()) {
      if (resource.vao) this.gl.deleteVertexArray(resource.vao);
      for (const key of ["positionBuffer", "uvBuffer", "indexBuffer"]) {
        if (resource[key]) this.gl.deleteBuffer(resource[key]);
      }
    }
    set.resources.clear();
    for (const texture of set.textures.values()) this.gl.deleteTexture(texture);
    set.textures.clear();
  }

  #releaseTarget(target) {
    if (target.texture) this.gl.deleteTexture(target.texture);
    if (target.framebuffer) this.gl.deleteFramebuffer(target.framebuffer);
    if (target.stencil) this.gl.deleteRenderbuffer(target.stencil);
  }

  #disposeTargets() {
    for (const target of this.targets) this.#releaseTarget(target);
    this.targets = [];
    this.metrics.surfaceBytes = 0;
  }

  #disposePrograms() {
    this.gl.useProgram(null); // A deleted current program otherwise stays alive until unbound.
    if (this.program) this.gl.deleteProgram(this.program);
    if (this.compositeProgram) this.gl.deleteProgram(this.compositeProgram);
    this.program = this.compositeProgram = null;
  }

  disposeResources() {
    this.#release(this);
    this.metrics.textureBytes = 0;
  }

  dispose() {
    if (this.state === "disposed") return;
    this.state = "disposed";
    this.pendingLoad?.abort();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.disposeResources();
    this.#disposeTargets();
    this.#disposePrograms();
    this.model = null;
    this.images.clear();
  }
}
