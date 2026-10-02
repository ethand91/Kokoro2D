import { contourProblem, seedContour } from "./region-geometry.js";

const clamp = value => Math.max(0, Math.min(1, value));
const score = points => Math.min(...points.map(p => clamp(p[2])));

// hysts/anime-face-detector's published 28-point layout. The lower eye points
// run left-to-right too, so reverse them to make a perimeter rather than a bowtie.
const FEATURES = {
  leftEye: [11, 12, 13, 16, 15, 14],
  rightEye: [17, 18, 19, 22, 21, 20],
  mouth: [24, 25, 26, 27],
};

function region(name, points, width, height) {
  let contour = points.map(p => [Math.max(0, Math.min(width, p[0])), Math.max(0, Math.min(height, p[1]))]);
  if (name === "mouth") {
    const [left, upper, right, lower] = contour;
    const curve = (middle, t) => [left[0] + (right[0] - left[0]) * t,
      (1-t)*left[1] + t*right[1] + 4*t*(1-t)*(middle[1] - (left[1]+right[1])/2)];
    contour = [...Array.from({length:9}, (_,i)=>curve(upper,i/8)),
      ...Array.from({length:7}, (_,i)=>curve(lower,(7-i)/8))];
  }
  const xs = contour.map(p => p[0]), ys = contour.map(p => p[1]);
  const x = Math.max(0, Math.min(width - 2, Math.min(...xs)));
  const y = Math.max(0, Math.min(height - 2, Math.min(...ys)));
  const r = { x, y, width: Math.max(2, Math.max(...xs) - x), height: Math.max(2, Math.max(...ys) - y), confidence: score(points) };
  // A smile curves downward even when closed: use the central lip gap, not
  // the height of the entire smile, to distinguish an opening from a line.
  if (name === "mouth" && Math.hypot(points[1][0] - points[3][0], points[1][1] - points[3][1]) / r.width < 0.10) {
    r.sourceClosed = true;
    if (Math.max(...ys) - Math.min(...ys) < 2) {
      const h = Math.min(height, Math.max(3, r.width * 0.08));
      r.y = Math.max(0, Math.min(height - h, y + r.height / 2 - h / 2));
      r.height = h;
      contour = seedContour(name, r);
    }
  }
  r.contour = contourProblem(contour, width, height) ? seedContour(name, r) : contour;
  return r;
}

export function applyAnimeLandmarks(analysis, result, width, height) {
  if (result?.width !== width || result?.height !== height || !Array.isArray(result.faces)) {
    throw new Error("Anime landmarks do not match the source image.");
  }
  const faces = result.faces.filter(f => Array.isArray(f.bbox) && f.bbox.length === 5
    && f.bbox.every(Number.isFinite) && f.bbox[4] >= 0.5
    && f.bbox[2] > f.bbox[0] && f.bbox[3] > f.bbox[1]
    && Array.isArray(f.keypoints) && f.keypoints.length === 28
    && f.keypoints.every(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)
      && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height));
  faces.sort((a, b) => (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) - (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]));
  if (!faces.length) throw new Error("No anime face found. The original outlines were kept.");
  const { keypoints: p, bbox } = faces[0];
  if (score(p.slice(0, 11)) < 0.3) throw new Error("Anime face outline is uncertain. The original outlines were kept.");
  // Use the jaw and brows to exclude animal ears and hair included in the box.
  const eyeY = (p[12][1] + p[18][1]) / 2;
  const top = Math.max(0, Math.min(...p.slice(5, 11).map(pt => pt[1])) - Math.max(2, p[2][1] - eyeY) * 0.45);
  const face = region("face", [[p[0][0], top, bbox[4]], [p[4][0], top, bbox[4]], p[4], p[3], p[2], p[1], p[0]], width, height);
  face.method = "anime landmarks";
  const features = { ...analysis.features };
  // Preserve extraction warnings; replace only the heuristic placement warnings.
  const warnings = analysis.warnings.filter(w => !/^(Face placement|No neck|One or both eye|Mouth placement|Anime )/.test(w));
  for (const [name, indices] of Object.entries(FEATURES)) {
    const points = indices.map(i => p[i]);
    if (score(points) < 0.3) warnings.push(`Anime ${name} landmarks were uncertain; the estimated outline was kept.`);
    else features[name] = region(name, points, width, height);
  }
  if (faces.length > 1) warnings.push("Multiple anime faces found; the largest face was selected. Check the outlines.");
  return { ...analysis, face, features, warnings, style: "anime", landmarkMethod: "Anime landmarks",
    confidence: Math.min(analysis.extraction, face.confidence, ...Object.values(features).map(r => r.confidence)) };
}

export async function detectAnimeLandmarks(imageData, { signal } = {}) {
  const canvas = Object.assign(document.createElement("canvas"), { width: imageData.width, height: imageData.height });
  canvas.getContext("2d").putImageData(imageData, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  const response = await fetch("/api/anime-landmarks", {
    method: "POST", headers: { "Content-Type": "image/png" }, body: blob,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(125000)]) : AbortSignal.timeout(125000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? "Anime detector unavailable. Start the local server with detector support.");
  }
  return response.json();
}
