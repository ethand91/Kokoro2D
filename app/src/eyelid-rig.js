import { createLayer, ensureKeyform } from "./model.js";
import { authorSampleBlink } from "./sample-blink.js";
import { eyeProfile, regionContains, seedContour } from "./region-geometry.js";

const clamp = v => Math.max(0, Math.min(1, v));
// Preserve the complete source eye. Only its aperture closes; iris/highlights
// remain stable. The editable aperture is separate from the erased paint area.
export function authorPaintedEye(opening, eye, lashes, aperture, paint, imageData, scale) {
  aperture = { ...aperture, contour: aperture.contour ?? seedContour("leftEye", aperture) };
  const canvas = (w, h) => Object.assign(document.createElement("canvas"), { width: Math.ceil(w), height: Math.ceil(h) });
  const source = canvas(imageData.width, imageData.height); source.getContext("2d").putImageData(imageData, 0, 0);
  const c = canvas(paint.width, paint.height), ctx = c.getContext("2d");
  ctx.drawImage(source, paint.x, paint.y, paint.width, paint.height, 0, 0, c.width, c.height);
  const expressions = Object.entries(eye.keyforms).filter(([id]) => id.startsWith("expr."));
  const replacement = createLayer({ name: eye.name, src: c.toDataURL(), width: paint.width * scale, height: paint.height * scale,
    x: opening.transform.x, y: opening.transform.y, zIndex: eye.zIndex, columns: 24, rows: 12 });
  Object.assign(eye, replacement, { id: eye.id, parent: eye.parent, clipMask: opening.id });
  for (const [id, keys] of expressions) for (const key of keys) Object.assign(ensureKeyform(eye, id, key.value).transform, key.transform);
  for (const direction of [-1, 1]) for (const axis of ["X", "Y"]) {
    const key = ensureKeyform(eye, `eyes.look${axis}`, direction);
    for (let i = 0; i < eye.mesh.vertices.length; i += 2) {
      const u = eye.mesh.uvs[i], v = eye.mesh.uvs[i + 1], weight = Math.sin(Math.PI * u) ** 2 * Math.sin(Math.PI * v) ** 2;
      key.offsets[i + (axis === "Y" ? 1 : 0)] = direction * (axis === "X" ? paint.width : paint.height) * scale * .12 * weight;
    }
  }
  const band = { height: Math.max(8, Math.ceil(paint.height * .48)), baseline: Math.max(6, Math.ceil(paint.height * .42)) };
  const ribbon = canvas(paint.width, band.height), rc = ribbon.getContext("2d"), pixels = rc.createImageData(ribbon.width, ribbon.height);
  for (let x = 0; x < ribbon.width; x++) for (let y = 0; y < ribbon.height; y++) {
    const sx = Math.floor(paint.x + x / ribbon.width * paint.width);
    const profile = eyeProfile(aperture, clamp((sx - aperture.x) / aperture.width));
    const sy = Math.floor(profile.upper + y - band.baseline);
    if (sy < 0 || sy >= imageData.height || sx < 0 || sx >= imageData.width || sy > profile.upper + 1 || !regionContains(paint, sx, sy)) continue;
    const at = (sy * imageData.width + sx) * 4, out = (y * ribbon.width + x) * 4;
    const color = imageData.data.subarray(at, at + 4);
    const ink = clamp((185 - Math.max(...color.subarray(0, 3))) / 70);
    pixels.data.set([color[0], color[1], color[2], color[3] * ink], out);
  }
  rc.putImageData(pixels, 0, 0); lashes.source.src = ribbon.toDataURL();
  authorSampleBlink(opening, eye, lashes, aperture, paint, scale, band);
  for (const layer of [opening, eye, lashes]) layer.eyeSide = eye.name.startsWith("Left") ? "Left" : "Right";
}
