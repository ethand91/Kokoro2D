import { createLayer, ensureKeyform } from "./model.js";
import { eyeProfile, updateContourBounds } from "./region-geometry.js";

// The white of the eye ends underneath the painted upper lash. These outlines
// are deliberately separate from the larger regions used to erase source eyes.
export function sampleEyeAperture(side) {
  const contour = side === "Left"
    ? [[294,266],[299,258],[308,252],[322,251],[335,252],[346,259],[352,269],[355,278],[351,285],[341,290],[328,292],[313,287],[303,278]]
    : [[417,251],[422,242],[432,237],[443,234],[455,234],[467,239],[475,246],[473,258],[466,270],[455,276],[443,278],[431,274],[423,266]];
  return updateContourBounds({ contour });
}

export function sampleLidProfile(aperture, u) {
  const profile = eyeProfile(aperture, Math.max(0, Math.min(1, u)));
  // Most travel belongs to the upper lid. The lower lid rises slightly, and
  // both meet on a curved line near the lower rim, with fixed eye corners.
  return { ...profile, closed: profile.upper * .12 + profile.lower * .88 };
}

function warp(layer, id, value, fn) {
  const key = ensureKeyform(layer, id, value);
  for (let i = 0; i < layer.mesh.vertices.length; i += 2) {
    [key.offsets[i], key.offsets[i + 1]] = fn(layer.mesh.vertices[i], layer.mesh.vertices[i + 1], layer.mesh.uvs[i], layer.mesh.uvs[i + 1]);
  }
}

function replaceLayer(target, replacement) {
  const { id, parent } = target;
  Object.assign(target, replacement, { id, parent });
}

export function authorSampleBlink(opening, eye, lashes, aperture, paintRegion, scale, band = { height: 32, baseline: 28 }) {
  const apertureX = aperture.x + aperture.width / 2, apertureY = aperture.y + aperture.height / 2;
  const paintX = paintRegion.x + paintRegion.width / 2, paintY = paintRegion.y + paintRegion.height / 2;
  const x = eye.transform.x + (apertureX - paintX) * scale;
  const y = eye.transform.y + (apertureY - paintY) * scale;
  const mask = createLayer({ name: opening.name, src: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path fill="white" d="M0 0h1v1H0z"/></svg>'),
    width: aperture.width * scale, height: aperture.height * scale, x, y, zIndex: opening.zIndex, columns: 32, rows: 4 });
  mask.maskOnly = true;
  for (let i = 0; i < mask.mesh.vertices.length; i += 2) {
    const u = mask.mesh.uvs[i], v = mask.mesh.uvs[i + 1], profile = sampleLidProfile(aperture, u);
    mask.mesh.vertices[i + 1] = (profile.upper * (1 - v) + profile.lower * v - apertureY) * scale;
  }
  replaceLayer(opening, mask);
  warp(opening, "eyes.blink", 1, (x, y, u) => [0, (sampleLidProfile(aperture, u).closed - apertureY) * scale - y]);

  // The stencil reveals skin above the stable pupil. Compressing the painted
  // eye itself would squash its iris and highlights at every partial blink.
  delete eye.keyforms["eyes.blink"];

  const ribbon = createLayer({ name: lashes.name, src: lashes.source.src,
    width: paintRegion.width * scale, height: band.height * scale,
    x: eye.transform.x, y: eye.transform.y, zIndex: lashes.zIndex, columns: 32, rows: 6 });
  for (let i = 0; i < ribbon.mesh.vertices.length; i += 2) {
    const u = ribbon.mesh.uvs[i], v = ribbon.mesh.uvs[i + 1];
    const sourceX = paintRegion.x + u * paintRegion.width;
    const profile = sampleLidProfile(aperture, (sourceX - aperture.x) / aperture.width);
    ribbon.mesh.vertices[i + 1] = (profile.upper - paintY + v * band.height - band.baseline) * scale;
  }
  replaceLayer(lashes, ribbon);
  warp(lashes, "eyes.blink", 1, (x, y, u) => {
    const sourceX = paintRegion.x + u * paintRegion.width;
    const profile = sampleLidProfile(aperture, (sourceX - aperture.x) / aperture.width);
    const baseline = (profile.upper - paintY) * scale;
    // Only the lash band becomes thinner. Its lower edge rides the lid from
    // the first instant of closure, without an opacity hand-off or a new bar.
    return [0, (profile.closed - profile.upper) * scale - (y - baseline) * .42];
  });

  for (const id of ["expr.happy", "expr.sad", "expr.angry", "expr.confused"]) {
    const displacement = (u) => {
      const inside = sideTowardNose(lashes.name, u), envelope = Math.sin(Math.PI * u);
      const amount = id === "expr.happy" ? -.10 * envelope
        : id === "expr.sad" ? .16 * (1 - inside) * envelope
        : id === "expr.angry" ? .20 * inside * envelope
        : (lashes.name.startsWith("Left") ? -.10 : .10) * envelope;
      return amount * aperture.height * scale;
    };
    // Apply the same per-column bend to the mask and lashes. At full closure
    // every mask row still coincides, including when expressions are blended.
    warp(opening, id, 1, (x, y, u) => [0, displacement(u)]);
    warp(lashes, id, 1, (x, y, u) => [0, displacement(Math.max(0, Math.min(1, (paintRegion.x + u * paintRegion.width - aperture.x) / aperture.width)))]);
  }
}

function sideTowardNose(name, u) {
  return name.startsWith("Left") ? u : 1 - u;
}
