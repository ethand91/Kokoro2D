import { ensureKeyform } from './model.js';

// Bake the portrait's triangle displacement into expression patches. Generated
// layers use translation only, so both meshes share the same coordinate space.
export function attachToPortrait(layer, portrait) {
  const { columns, rows, vertices } = portrait.mesh;
  const width = vertices[columns * 2] - vertices[0];
  const height = vertices[rows * (columns + 1) * 2 + 1] - vertices[1];
  for (const [parameter, keys] of Object.entries(portrait.keyforms)) {
    for (const source of keys) {
      const key = ensureKeyform(layer, parameter, source.value);
      for (let i = 0; i < layer.mesh.vertices.length; i += 2) {
        const x = layer.mesh.vertices[i] + layer.transform.x - portrait.transform.x;
        const y = layer.mesh.vertices[i + 1] + layer.transform.y - portrait.transform.y;
        const u = Math.max(0, Math.min(columns, (x - vertices[0]) / width * columns));
        const v = Math.max(0, Math.min(rows, (y - vertices[1]) / height * rows));
        const col = Math.min(columns - 1, Math.floor(u));
        const row = Math.min(rows - 1, Math.floor(v));
        const fx = u - col;
        const fy = v - row;
        const tl = row * (columns + 1) + col;
        const samples = fx + fy <= 1
          ? [[tl, 1 - fx - fy], [tl + 1, fx], [tl + columns + 1, fy]]
          : [[tl + 1, 1 - fy], [tl + columns + 1, 1 - fx], [tl + columns + 2, fx + fy - 1]];
        for (let axis = 0; axis < 2; axis += 1) {
          key.offsets[i + axis] = samples.reduce((sum, [vertex, weight]) => sum + source.offsets[vertex * 2 + axis] * weight, 0);
        }
      }
    }
  }
}
