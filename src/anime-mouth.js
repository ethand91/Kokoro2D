import { ensureKeyform } from "./model.js";
import { eyeProfile } from "./region-geometry.js";

// The source contour locates the lips; it is not the shape of the oral cavity.
// In particular, enlarging a closed smile preserves its tiny central gap.
export function authorAnimeMouth(mouth, lips, source, opening, scale) {
  const w = opening.width, h = opening.height;
  const path = `M0 ${h/2} Q${w/2} ${-h/2} ${w} ${h/2} Q${w/2} ${h*1.5} 0 ${h/2}Z`;
  const art = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<defs><clipPath id="mouth"><path d="${path}"/></clipPath></defs>`
    + `<path d="${path}" fill="#57202f"/><g clip-path="url(#mouth)">`
    + `<ellipse cx="${w*.5}" cy="${h*.88}" rx="${w*.25}" ry="${h*.10}" fill="#c8677a"/>`
    + `<path d="M${w*.24} ${h*.15}Q${w*.5} ${h*.09} ${w*.76} ${h*.15}" stroke="#fdeee2" stroke-width="${h*.07}" fill="none"/>`
    + `</g></svg>`;
  mouth.source.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(art)}`;
  mouth.transform.scaleY = 1;
  mouth.transform.opacity = 0;
  for (const id of ["mouth.open", "mouth.form", "mouth.round"]) delete mouth.keyforms[id];
  // Quiet speech is a narrow opening, not a miniature shout. Opacity reaches
  // solid early so the inside never looks like a translucent patch of lipstick.
  const stages = [[.06, .025], [.3, .22], [1, 1]].map(([value, amount]) => {
    const key = ensureKeyform(mouth, "mouth.open", value);
    key.transform.opacity = 1;
    key.transform.scaleX = -.08 * amount;
    return [key, amount];
  });
  const profileAt = u => source.contour ? eyeProfile(source, u) : null;
  const center = profileAt(.5);
  const left = source.contour?.reduce((a,b)=>a[0]<b[0]?a:b);
  const right = source.contour?.reduce((a,b)=>a[0]>b[0]?a:b);
  const centerY = source.sourceClosed && center ? (center.upper + center.lower) / 2 : source.y + source.height / 2;
  const sag = left && right ? centerY - (left[1] + right[1]) / 2 : 0;
  for (let i = 0; i < mouth.mesh.vertices.length; i += 2) {
    const u = mouth.mesh.uvs[i], v = mouth.mesh.uvs[i + 1];
    // Sparse landmarks give a V-shaped smile if joined with straight lines.
    // A quadratic lip arc follows the corners and middle without that cusp.
    const chord = left && right ? left[1] + (right[1] - left[1]) * u : centerY;
    const arc = source.sourceClosed ? 4 * u * (1 - u) * sag : 0;
    const line = (chord + arc - opening.y - h / 2) * scale;
    const travel = (v - .28) * h * scale;
    mouth.mesh.vertices[i + 1] = line + travel * .025;
    for (const [key, amount] of stages) {
      // Opening relaxes the resting smile into a round cavity, not a chevron.
      key.offsets[i + 1] = (travel * .975 + (sag - arc) * scale * .85) * amount;
    }
  }
  // A/ah opens, E/ee spreads and flattens, O/oo narrows and lengthens. These
  // remain blendable channels; microphone spectra are only a rough vowel cue.
  Object.assign(ensureKeyform(mouth, "mouth.form", -1).transform, { scaleX: -.10, scaleY: .04 });
  Object.assign(ensureKeyform(mouth, "mouth.form", 1).transform, { scaleX: .18, scaleY: -.14 });
  Object.assign(ensureKeyform(mouth, "mouth.round", 1).transform, { scaleX: -.36, scaleY: .22 });
  if (lips) {
    delete lips.keyforms["mouth.open"];
    ensureKeyform(lips, "mouth.open", .06).transform.opacity = -1;
  }
}
