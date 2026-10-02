import { evaluateLayer } from './model.js';

export const identity = () => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 });
export function transformPoint(x, y, t) {
  const c = Math.cos(t.rotation), s = Math.sin(t.rotation);
  return [c * x * t.scaleX - s * y * t.scaleY + t.x, s * x * t.scaleX + c * y * t.scaleY + t.y];
}
export function inversePoint(x, y, t) {
  const c = Math.cos(t.rotation), s = Math.sin(t.rotation);
  return [(c * (x - t.x) + s * (y - t.y)) / (t.scaleX || 1e-8), (-s * (x - t.x) + c * (y - t.y)) / (t.scaleY || 1e-8)];
}

// Binding captures the undeformed cage. Editing that cage later moves its children.
export function bindParent(layer, parent) {
  layer.parent = { id: parent.id, bind: { vertices: [...parent.mesh.vertices], indices: [...parent.mesh.indices], columns: parent.mesh.columns, rows: parent.mesh.rows, transform: { ...parent.transform } } };
}

export function triangleWeights(x, y, vertices, indices) {
  let best = null, penalty = Infinity;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3);
    const ax = vertices[a * 2], ay = vertices[a * 2 + 1];
    const bx = vertices[b * 2], by = vertices[b * 2 + 1];
    const cx = vertices[c * 2], cy = vertices[c * 2 + 1];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-10) continue;
    const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
    const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
    const wc = 1 - wa - wb;
    const cost = Math.max(0, -wa) + Math.max(0, -wb) + Math.max(0, -wc);
    if (cost < penalty) { best = [[a, wa], [b, wb], [c, wc]]; penalty = cost; }
    if (cost < 1e-8) break;
  }
  return best;
}
function weightedPoint(weights, vertices) {
  return [0, 1].map(axis => weights.reduce((sum, [v, w]) => sum + vertices[v * 2 + axis] * w, 0));
}
const bindingCache = new WeakMap();
function bindWeights(layer, x, y) {
  let cache = bindingCache.get(layer.parent);
  if (!cache) { cache = new Map(); bindingCache.set(layer.parent, cache); }
  const key = `${x.toFixed(5)},${y.toFixed(5)}`;
  if (cache.has(key)) return cache.get(key);
  const b = layer.parent.bind;
  let weights;
  const cols = b.columns, rows = b.rows;
  const width = b.vertices[cols * 2] - b.vertices[0];
  const height = b.vertices[rows * (cols + 1) * 2 + 1] - b.vertices[1];
  if (cache.regular === undefined) cache.regular = b.vertices.every((value, i) => Math.abs(value - (i % 2 ? b.vertices[1] + Math.floor(i / 2 / (cols + 1)) / rows * height : b.vertices[0] + (i / 2 % (cols + 1)) / cols * width)) < 1e-6);
  if (cache.regular) {
    const u = (x - b.vertices[0]) / width * cols, v = (y - b.vertices[1]) / height * rows;
    const col = Math.max(0, Math.min(cols - 1, Math.floor(u))), row = Math.max(0, Math.min(rows - 1, Math.floor(v)));
    const fx = u - col, fy = v - row, tl = row * (cols + 1) + col;
    weights = fx + fy <= 1 ? [[tl, 1-fx-fy], [tl+1, fx], [tl+cols+1, fy]] : [[tl+1, 1-fy], [tl+cols+1, 1-fx], [tl+cols+2, fx+fy-1]];
  } else weights = triangleWeights(x, y, b.vertices, b.indices);
  if (cache.size > 10000) cache.clear();
  cache.set(key, weights);
  return weights;
}
export function evaluateScene(model, parameters) {
  const poses = new Map(), visiting = new Set();
  const layers = new Map(model.layers.map(layer => [layer.id, layer]));
  function visit(layer) {
    if (poses.has(layer.id)) return poses.get(layer.id);
    if (visiting.has(layer.id)) throw new Error('Cyclic parent hierarchy.');
    visiting.add(layer.id);
    const pose = evaluateLayer(layer, parameters, model.parameters);
    const parent = layers.get(layer.parent?.id);
    const parentPose = parent ? visit(parent) : null;
    const world = [];
    for (let i = 0; i < pose.vertices.length; i += 2) {
      let point = transformPoint(pose.vertices[i], pose.vertices[i + 1], pose.transform);
      if (parentPose) {
        const local = inversePoint(...point, layer.parent.bind.transform);
        const weights = bindWeights(layer, ...local);
        if (weights) point = weightedPoint(weights, parentPose.vertices);
      }
      world.push(...point);
    }
    const result = { vertices: world, transform: { ...identity(), opacity: pose.transform.opacity } };
    visiting.delete(layer.id);
    poses.set(layer.id, result);
    return result;
  }
  model.layers.forEach(visit);
  return poses;
}

// Convert the editor's world pointer through the current parent cage first.
export function sceneToLayer(layer, x, y, model, parameters) {
  if (layer.parent) {
    const poses = evaluateScene(model, parameters);
    const parentPose = poses.get(layer.parent.id);
    const b = layer.parent.bind;
    const weights = triangleWeights(x, y, parentPose.vertices, b.indices);
    if (weights) [x, y] = transformPoint(...weightedPoint(weights, b.vertices), b.transform);
  }
  return inversePoint(x, y, evaluateLayer(layer, parameters, model.parameters).transform);
}
