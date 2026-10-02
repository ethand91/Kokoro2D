import { ensureKeyform } from "./model.js";

const clamp = v => Math.max(0, Math.min(1, v));
const smooth = v => { const t = clamp(v); return t*t*(3-2*t); };

// A shared cage carries every painted part, including hair/ears that could not
// be separated. Coordinates are source-image coordinates, not texture UV space.
export function authorPortraitMotion(root, rect, face, subject, scale) {
  const neckX = face.x + face.width / 2;
  const neckY = face.y + face.height;
  const bottom = subject.y + subject.height;
  const headWeight = y => 1 - smooth((y - neckY) / Math.max(1, face.height * .65));
  const posture = y => smooth((bottom - y) / Math.max(1, bottom - neckY));
  const channels = ['head.yaw', 'head.pitch', 'head.roll', 'body.sway', 'body.breathe'];
  for (const id of channels) for (const d of [-1, 1]) {
    const key = ensureKeyform(root, id, d);
    for (let i = 0; i < root.mesh.vertices.length; i += 2) {
      const x = rect.x + root.mesh.uvs[i] * rect.width;
      const y = rect.y + root.mesh.uvs[i + 1] * rect.height;
      const weight = headWeight(y), dx = x - neckX, dy = y - neckY;
      let ox = 0, oy = 0;
      if (id === 'head.yaw') {
        ox = d * face.width * .075 * weight;
        oy = -d * dx * .012 * weight;
      } else if (id === 'head.pitch') {
        oy = d * face.height * .035 * weight;
        ox = d * dx * .012 * weight;
      } else if (id === 'head.roll') {
        const angle = d * .075 * weight;
        ox = dx*Math.cos(angle)-dy*Math.sin(angle)-dx;
        oy = dx*Math.sin(angle)+dy*Math.cos(angle)-dy;
      } else if (id === 'body.sway') {
        ox = d * subject.width * .045 * posture(y);
      } else {
        // A small shared rise keeps the head attached to breathing shoulders.
        oy = -d * subject.height * .003 * posture(y);
      }
      key.offsets[i] = ox * scale;
      key.offsets[i + 1] = oy * scale;
    }
  }
}
