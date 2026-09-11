import { evaluateLayer } from "./model.js";

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
out vec4 outColor;
void main() {
  vec2 textureUv = u_uv_rect.xy + v_uv * u_uv_rect.zw;
  vec4 color = texture(u_texture, textureUv);
  float rectangleEdge = min(min(v_uv.x, 1.0 - v_uv.x), min(v_uv.y, 1.0 - v_uv.y));
  float ellipseEdge = (1.0 - length((v_uv - 0.5) * 2.0)) * 0.5;
  float edge = mix(rectangleEdge, ellipseEdge, u_ellipse_mask);
  float featherMask = u_edge_feather > 0.0 ? smoothstep(0.0, u_edge_feather, edge) : 1.0;
  outColor = vec4(color.rgb, color.a * u_opacity * featherMask);
}`;

function shader(gl, type, source) {
  const result = gl.createShader(type);
  gl.shaderSource(result, source);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(result) || "Shader compilation failed.");
  }
  return result;
}

function program(gl) {
  const result = gl.createProgram();
  gl.attachShader(result, shader(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(result, shader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(result);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(result) || "Shader linking failed.");
  }
  return result;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to decode a layer image."));
    image.src = src;
  });
}

export class KokoroRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!this.gl) throw new Error("Kokoro2D requires WebGL2.");
    this.program = program(this.gl);
    this.model = null;
    this.parameters = {};
    this.resources = new Map();
    this.camera = { x: 0, y: 0, zoom: 0.78 };
    this.locations = this.#locations();
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
  }

  #locations() {
    const gl = this.gl;
    const getAttribute = (name) => gl.getAttribLocation(this.program, name);
    const getUniform = (name) => gl.getUniformLocation(this.program, name);
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
      ellipseMask: getUniform("u_ellipse_mask"),
    };
  }

  async setModel(model) {
    this.disposeResources();
    this.model = model;
    await Promise.all(model.layers.map(async (layer) => {
      const image = await loadImage(layer.source.src);
      this.resources.set(layer.id, this.#createLayerResources(layer, image));
    }));
  }

  #createLayerResources(layer, image) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(layer.mesh.vertices), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.locations.position);
    gl.vertexAttribPointer(this.locations.position, 2, gl.FLOAT, false, 0, 0);

    const uvBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(layer.mesh.uvs), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.locations.uv);
    gl.vertexAttribPointer(this.locations.uv, 2, gl.FLOAT, false, 0, 0);

    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(layer.mesh.indices), gl.STATIC_DRAW);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.bindVertexArray(null);
    const crop = layer.source.crop;
    const uvRect = crop
      ? [crop.x / image.width, crop.y / image.height, crop.width / image.width, crop.height / image.height]
      : [0, 0, 1, 1];
    return {
      vao,
      positionBuffer,
      uvBuffer,
      indexBuffer,
      texture,
      count: layer.mesh.indices.length,
      uvRect,
      edgeFeather: Math.max(0, Math.min(0.49, Number(layer.source.feather ?? 0))),
      ellipseMask: layer.source.mask === "ellipse" ? 1 : 0,
    };
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

  render(parameters = this.parameters) {
    if (!this.model) return;
    this.parameters = parameters;
    this.resize();
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.locations.resolution, gl.canvas.width, gl.canvas.height);
    gl.uniform2f(this.locations.camera, this.camera.x, this.camera.y);
    gl.uniform1f(this.locations.zoom, this.camera.zoom * (gl.canvas.width / gl.canvas.clientWidth));

    const layers = [...this.model.layers].sort((a, b) => a.zIndex - b.zIndex);
    for (const layer of layers) {
      if (!layer.visible) continue;
      const resources = this.resources.get(layer.id);
      if (!resources) continue;
      const pose = evaluateLayer(layer, parameters, this.model.parameters);
      gl.bindVertexArray(resources.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pose.vertices), gl.DYNAMIC_DRAW);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, resources.texture);
      gl.uniform2f(this.locations.translation, pose.transform.x, pose.transform.y);
      gl.uniform2f(this.locations.scale, pose.transform.scaleX, pose.transform.scaleY);
      gl.uniform1f(this.locations.rotation, pose.transform.rotation);
      gl.uniform1f(this.locations.opacity, pose.transform.opacity);
      gl.uniform4fv(this.locations.uvRect, resources.uvRect);
      gl.uniform1f(this.locations.edgeFeather, resources.edgeFeather);
      gl.uniform1f(this.locations.ellipseMask, resources.ellipseMask);
      gl.drawElements(gl.TRIANGLES, resources.count, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
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

  disposeResources() {
    for (const resources of this.resources.values()) {
      this.gl.deleteVertexArray(resources.vao);
      this.gl.deleteBuffer(resources.positionBuffer);
      this.gl.deleteBuffer(resources.uvBuffer);
      this.gl.deleteBuffer(resources.indexBuffer);
      this.gl.deleteTexture(resources.texture);
    }
    this.resources.clear();
  }
}
