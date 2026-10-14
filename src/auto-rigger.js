import { applyAnimeLandmarks, detectAnimeLandmarks } from "./anime-landmarks.js";
import { addRegionContours } from "./region-geometry.js";
import { buildLayeredRig, defaultRegions, fitRegions } from "./layered-rig.js";

// Every ratio below differs by drawing style, and no single set serves both.
// An anime face has eyes about a fifth of its height set close together, with a
// small mouth close under them; a realistically drawn one has eyes a third that
// size, prominent brows, and a mouth nearly twice as wide sitting nearly twice
// as far down. Multipliers with two entries are [after a neck cut, without one].
export const PROPORTIONS = Object.freeze({
  anime: Object.freeze({
    label: 'Anime',
    faceWidth: [0.82, 1.25], faceHeight: [0.86, 1.22],
    eyeWindow: [0.30, 0.14],       // search window, as a share of the face box
    eyeBand: [0.26, 0.36],         // band top and height, share of face height
    eyeSize: [0.55, 0.37],         // final rectangle, share of interocular
    mouthDrop: 0.33,               // band top below the eye line, x interocular
    mouthBand: [0.5, 0.60],        // band width and height, x interocular
    mouthSize: [0.28, 0.15],       // final rectangle, x interocular
  }),
  realistic: Object.freeze({
    label: 'Realistic',
    faceWidth: [0.86, 1.25], faceHeight: [0.9, 1.22],
    eyeWindow: [0.24, 0.11],
    eyeBand: [0.34, 0.3],
    eyeSize: [0.5, 0.23],
    mouthDrop: 0.72,
    mouthBand: [0.72, 0.36],
    mouthSize: [0.55, 0.17],
  }),
});

const MAX_ANALYSIS_SIDE = 1400;
const MASK_THRESHOLD = 24;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function luminance(red, green, blue) {
  return red * 0.299 + green * 0.587 + blue * 0.114;
}

function colorDistance(data, offset, color) {
  const red = data[offset] - color[0];
  const green = data[offset + 1] - color[1];
  const blue = data[offset + 2] - color[2];
  return Math.sqrt(red * red * 0.30 + green * green * 0.59 + blue * blue * 0.11);
}

function borderPalette(imageData) {
  const { width, height, data } = imageData;
  const points = [
    [0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1],
    [Math.floor(width / 2), 0], [Math.floor(width / 2), height - 1],
  ];
  const samples = points.map(([x, y]) => {
    const offset = (y * width + x) * 4;
    return [data[offset], data[offset + 1], data[offset + 2]];
  });
  // A cropped portrait's bottom-center sample is usually clothing. Never add
  // each edge color to the flood palette: that erases the connected torso.
  const clusters = samples.map(color => samples.filter(sample => colorDistance(sample, 0, color) <= 12));
  clusters.sort((a, b) => b.length - a.length);
  const dominant = clusters[0];
  // Without a strict majority, keep the artwork rather than guessing which
  // of two large border regions is the character.
  return dominant.length > samples.length / 2 ? dominant : [];
}

function isSkin(red, green, blue) {
  if (red < 55 || green < 32 || blue < 24) return false;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const cb = 128 - 0.169 * red - 0.331 * green + 0.5 * blue;
  const cr = 128 + 0.5 * red - 0.419 * green - 0.081 * blue;
  const warm = red >= green * 0.92 && red >= blue * 0.92 && maximum - minimum > 8;
  return warm && cb >= 72 && cb <= 142 && cr >= 124 && cr <= 188;
}

function softenMask(mask, width, height) {
  const result = new Uint8ClampedArray(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let count = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const sampleX = x + offsetX;
          const sampleY = y + offsetY;
          if (sampleX < 0 || sampleY < 0 || sampleX >= width || sampleY >= height) continue;
          total += mask[sampleY * width + sampleX];
          count += 1;
        }
      }
      result[y * width + x] = total / count;
    }
  }
  return result;
}

export function extractSubjectMask(imageData) {
  const { width, height, data } = imageData;
  const pixelCount = width * height;
  let transparentPixels = 0;
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] < 245) transparentPixels += 1;
  }

  if (transparentPixels / pixelCount > 0.015) {
    const alphaMask = new Uint8ClampedArray(pixelCount);
    for (let pixel = 0; pixel < pixelCount; pixel += 1) alphaMask[pixel] = data[pixel * 4 + 3];
    return { mask: alphaMask, mode: "existing transparency", confidence: 0.98 };
  }

  const palette = borderPalette(imageData);
  if (!palette.length) {
    return { mask: new Uint8ClampedArray(pixelCount).fill(255), mode: "full image fallback", confidence: 0.28 };
  }
  // Protect pale skin near a light background even when its color falls within
  // the flood tolerance, unless the background is itself skin-toned.
  const borderIsSkin = palette.some((color) => isSkin(color[0], color[1], color[2]));
  const background = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  const enqueue = (index) => {
    if (background[index]) return;
    const offset = index * 4;
    if (!borderIsSkin && isSkin(data[offset], data[offset + 1], data[offset + 2])) return;
    const distance = Math.min(...palette.map((color) => colorDistance(data, offset, color)));
    // A broad tolerance eats pale anime clothes even with the right palette.
    if (distance > 18) return;
    background[index] = 1;
    queue[tail++] = index;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }

  const mask = new Uint8ClampedArray(pixelCount);
  let foreground = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    mask[index] = background[index] ? 0 : 255;
    foreground += background[index] ? 0 : 1;
  }
  const ratio = foreground / pixelCount;
  if (ratio < 0.05 || ratio > 0.96) {
    mask.fill(255);
    return { mask, mode: "full image fallback", confidence: 0.28 };
  }
  return {
    mask: softenMask(mask, width, height),
    mode: "border background extraction",
    confidence: clamp(1 - Math.abs(ratio - 0.48) * 0.75, 0.48, 0.88) * palette.length / 6,
  };
}

export function maskBounds(mask, width, height, threshold = MASK_THRESHOLD) {
  let minimumX = width;
  let minimumY = height;
  let maximumX = -1;
  let maximumY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] <= threshold) continue;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }
  if (maximumX < minimumX) return { x: 0, y: 0, width, height };
  return {
    x: minimumX,
    y: minimumY,
    width: maximumX - minimumX + 1,
    height: maximumY - minimumY + 1,
  };
}

function skinBounds(imageData, subjectMask, subjectBounds) {
  const { width, height, data } = imageData;
  const searchBottom = Math.floor(subjectBounds.y + subjectBounds.height * 0.68);
  const candidates = new Uint8Array(width * height);
  for (let y = subjectBounds.y; y <= searchBottom; y += 1) {
    for (let x = subjectBounds.x; x < subjectBounds.x + subjectBounds.width; x += 1) {
      const index = y * width + x;
      if (subjectMask[index] < 128) continue;
      const offset = index * 4;
      if (!isSkin(data[offset], data[offset + 1], data[offset + 2])) continue;
      candidates[index] = 1;
    }
  }

  const queue = new Int32Array(width * height);
  const labels = new Int32Array(width * height).fill(-1);
  let best = null;
  let componentId = 0;
  for (let y = Math.floor(subjectBounds.y); y <= searchBottom; y += 1) {
    for (let x = Math.floor(subjectBounds.x); x < subjectBounds.x + subjectBounds.width; x += 1) {
      const seed = y * width + x;
      if (candidates[seed] !== 1) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = seed;
      candidates[seed] = 2;
      const id = componentId++;
      labels[seed] = id;
      const component = {
        id,
        count: 0, sumX: 0, sumY: 0,
        minimumX: width, minimumY: height, maximumX: -1, maximumY: -1,
      };
      while (head < tail) {
        const index = queue[head++];
        const pixelX = index % width;
        const pixelY = Math.floor(index / width);
        component.count += 1;
        component.sumX += pixelX;
        component.sumY += pixelY;
        component.minimumX = Math.min(component.minimumX, pixelX);
        component.minimumY = Math.min(component.minimumY, pixelY);
        component.maximumX = Math.max(component.maximumX, pixelX);
        component.maximumY = Math.max(component.maximumY, pixelY);
        const neighbors = [index - 1, index + 1, index - width, index + width];
        for (const neighbor of neighbors) {
          if (neighbor < 0 || neighbor >= candidates.length || candidates[neighbor] !== 1) continue;
          const neighborX = neighbor % width;
          if (Math.abs(neighborX - pixelX) > 1) continue;
          candidates[neighbor] = 2;
          labels[neighbor] = id;
          queue[tail++] = neighbor;
        }
      }
      const componentWidth = component.maximumX - component.minimumX + 1;
      const componentHeight = component.maximumY - component.minimumY + 1;
      const centerX = component.sumX / component.count;
      const centerY = component.sumY / component.count;
      const horizontalCentering = clamp(1 - Math.abs(centerX - (subjectBounds.x + subjectBounds.width / 2)) / subjectBounds.width, 0.35, 1);
      // A head is the topmost skin in a portrait. When a choker or collar cuts
      // the face off from the body, the bare chest and arms form a much larger
      // component, and raw pixel count let that outvote a face several times
      // smaller. Rank by where the region starts, with size only as a tiebreak.
      const topFraction = (component.minimumY - subjectBounds.y) / Math.max(1, subjectBounds.height);
      const headliness = clamp(1 - topFraction / 0.45, 0.04, 1);
      const aspect = componentWidth / Math.max(1, componentHeight);
      const aspectWeight = aspect >= 0.45 && aspect <= 1.8 ? 1 : 0.45;
      component.score = Math.sqrt(component.count) * horizontalCentering * headliness * aspectWeight;
      if (!best || component.score > best.score) best = component;
    }
  }
  if (!best) {
    return {
      count: 0, sumX: 0, sumY: 0,
      minimumX: width, minimumY: height, maximumX: -1, maximumY: -1, rows: [],
    };
  }
  best.rows = rowProfile(labels, best, width);
  return best;
}

// Horizontal extent of the chosen skin region on every row it occupies.
function rowProfile(labels, component, width) {
  const rows = [];
  for (let y = component.minimumY; y <= component.maximumY; y += 1) {
    let minimum = -1;
    let maximum = -1;
    let count = 0;
    let sumX = 0;
    for (let x = component.minimumX; x <= component.maximumX; x += 1) {
      if (labels[y * width + x] !== component.id) continue;
      if (minimum < 0) minimum = x;
      maximum = x;
      count += 1;
      sumX += x;
    }
    rows.push({ y, minimum, maximum, count, sumX, span: maximum < 0 ? 0 : maximum - minimum + 1 });
  }
  return rows;
}

// Exposed skin joins the face to the body through the neck, so the largest skin
// component is usually the whole character. The neck is the first row narrow
// enough to be a constriction that the body widens out of again; everything
// above it is the head. Returns -1 when no neck is visible, as in a bust crop
// or when hair covers the throat.
function neckRow(rows) {
  if (rows.length < 12) return -1;
  const above = new Array(rows.length).fill(0);
  const below = new Array(rows.length).fill(0);
  for (let i = 1; i < rows.length; i += 1) above[i] = Math.max(above[i - 1], rows[i - 1].span);
  for (let i = rows.length - 2; i >= 0; i -= 1) below[i] = Math.max(below[i + 1], rows[i + 1].span);
  for (let i = 4; i < rows.length - 4; i += 1) {
    if (above[i] < 10) continue;
    if (rows[i].span > above[i] * 0.55) continue;
    if (below[i] < above[i] * 0.8) continue;
    return i;
  }
  return -1;
}

function headAbove(rows, cut, taper) {
  let widest = 0;
  for (let i = 0; i < cut; i += 1) widest = Math.max(widest, rows[i].span);
  // Only fall back to the width taper when no neck was visible. A found neck
  // already marks where the head ends; trimming further on top of it ate the
  // lower jaw of a realistically drawn face and took the mouth with it.
  let chin = cut - 1;
  while (taper && chin > 0 && rows[chin].span < widest * 0.55) chin -= 1;
  const head = { count: 0, sumX: 0, sumY: 0, minimumX: Infinity, minimumY: Infinity, maximumX: -1, maximumY: -1 };
  const spans = [];
  for (let i = 0; i <= chin; i += 1) {
    const row = rows[i];
    if (!row.span) continue;
    head.count += row.count;
    head.sumX += row.sumX;
    head.sumY += row.count * row.y;
    head.minimumX = Math.min(head.minimumX, row.minimum);
    head.maximumX = Math.max(head.maximumX, row.maximum);
    head.minimumY = Math.min(head.minimumY, row.y);
    head.maximumY = Math.max(head.maximumY, row.y);
    spans.push(row.span);
  }
  // A high percentile rather than the extreme, so one ear or a raised hand
  // touching the cheek cannot widen the whole face.
  spans.sort((a, b) => a - b);
  head.spanWidth = spans[Math.floor(spans.length * 0.75)] ?? 0;
  return head.count ? head : null;
}

export function estimateFace(imageData, subjectMask, subjectBounds, proportions = PROPORTIONS.anime) {
  const component = skinBounds(imageData, subjectMask, subjectBounds);
  const rows = component.rows ?? [];
  const cut = neckRow(rows);
  // Trim to the chin either way. A full neck constriction is only visible when
  // the throat is bare; behind a collar the region still runs past the jaw, and
  // the jaw narrowing is the part that matters.
  const skin = (rows.length ? headAbove(rows, cut >= 0 ? cut : rows.length, cut < 0) : null) || component;
  const subjectArea = subjectBounds.width * subjectBounds.height;
  const usableSkin = skin.count > subjectArea * 0.004;
  if (usableSkin) {
    const centerX = skin.sumX / skin.count;
    const centerY = skin.sumY / skin.count;
    const skinWidth = skin.spanWidth || (skin.maximumX - skin.minimumX + 1);
    const skinHeight = skin.maximumY - skin.minimumY + 1;
    // The two paths measure different things. After a neck cut the region is the
    // whole head's skin - jaw, cheeks, the lot - and the face sits inside it.
    // With no cut it is usually the facial patch already enclosed by hair, which
    // needs widening rather than shrinking.
    const pick = (pair) => (cut >= 0 ? pair[0] : pair[1]);
    const faceWidth = clamp(skinWidth * pick(proportions.faceWidth), subjectBounds.width * 0.14, subjectBounds.width * 0.68);
    const faceHeight = clamp(skinHeight * pick(proportions.faceHeight), faceWidth * 0.82, faceWidth * 1.45);
    // Anchor the box on the chin rather than on the centroid. The chin is the
    // one landmark actually measured here - it is where the skin stops above
    // the neck - and everything below the eyes is placed relative to it. A box
    // floated on the centroid instead lands short on a face whose jaw tapers,
    // taking the mouth outside the face entirely.
    const chin = clamp(skin.maximumY + skinHeight * 0.04, subjectBounds.y + faceHeight, subjectBounds.y + subjectBounds.height);
    // Report what the estimate is actually worth. Density alone rated the old
    // whole-body box at 0.89: a blob that fills its own bounding box densely is
    // not evidence that the blob was a face.
    const density = clamp(skin.count / (faceWidth * faceHeight) * 1.6, 0, 1);
    const proportion = faceHeight / subjectBounds.height;
    const plausible = proportion >= 0.09 && proportion <= 0.62 ? 1 : 0.3;
    const bounded = faceWidth === subjectBounds.width * 0.68 || faceWidth === subjectBounds.width * 0.14 ? 0.55 : 1;
    return {
      x: clamp(centerX - faceWidth / 2, subjectBounds.x, subjectBounds.x + subjectBounds.width - faceWidth),
      y: clamp(chin - faceHeight, subjectBounds.y, subjectBounds.y + subjectBounds.height * 0.58),
      width: faceWidth,
      height: faceHeight,
      // No penalty for having found the face without a visible neck: measured
      // across 30 variants, that path is not less accurate, and docking it made
      // every calibration figure worse.
      confidence: clamp(density * plausible * bounded, 0.15, 0.92),
      method: cut >= 0 ? "head isolated above the neck" : "skin-region estimate",
    };
  }
  const width = subjectBounds.width * 0.48;
  const height = Math.min(subjectBounds.height * 0.38, width * 1.18);
  return {
    x: subjectBounds.x + (subjectBounds.width - width) / 2,
    y: subjectBounds.y + subjectBounds.height * 0.1,
    width,
    height,
    confidence: 0.32,
    method: "composition fallback",
  };
}

// Where is the densest patch of feature-coloured pixels? A centroid over the
// whole search band drifts outward toward scattered dark pixels - stray hair on
// a cheek, a shadow - which pushed the eye centres apart and the boxes with
// them. Sliding a window the size of the expected feature and taking the
// strongest response finds the cluster instead of averaging over the noise.
function densestWindow(imageData, subjectMask, bounds, scoring, windowWidth, windowHeight, fallbackX, fallbackY, support = null, candidateCount = 1) {
  const { width, height, data } = imageData;
  const startX = clamp(Math.floor(bounds.x), 0, width - 1);
  const endX = clamp(Math.ceil(bounds.x + bounds.width), 0, width);
  const startY = clamp(Math.floor(bounds.y), 0, height - 1);
  const endY = clamp(Math.ceil(bounds.y + bounds.height), 0, height);
  const bandWidth = endX - startX;
  const bandHeight = endY - startY;
  const missed = { x: fallbackX, y: fallbackY, height: Math.round(windowHeight), strength: 0, confidence: 0.2 };
  if (bandWidth < 2 || bandHeight < 2) return missed;

  const stride = bandWidth + 1;
  const integral = new Float64Array(stride * (bandHeight + 1));
  const backing = support ? new Float64Array(stride * (bandHeight + 1)) : null;
  for (let y = 0; y < bandHeight; y += 1) {
    let rowSum = 0;
    let rowSupport = 0;
    for (let x = 0; x < bandWidth; x += 1) {
      const index = (startY + y) * width + (startX + x);
      let score = 0;
      let backed = 0;
      if (subjectMask[index] >= 64) {
        const offset = index * 4;
        score = Math.max(0, scoring(data[offset], data[offset + 1], data[offset + 2], startX + x, startY + y));
        if (support) backed = Math.max(0, support(data[offset], data[offset + 1], data[offset + 2]));
      }
      rowSum += score;
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum;
      if (backing) {
        rowSupport += backed;
        backing[(y + 1) * stride + x + 1] = backing[y * stride + x + 1] + rowSupport;
      }
    }
  }

  const boxWidth = Math.round(clamp(windowWidth, 2, bandWidth));
  const boxHeight = Math.round(clamp(windowHeight, 2, bandHeight));
  const box = (table, x, y) => table[(y + boxHeight) * stride + x + boxWidth]
    - table[y * stride + x + boxWidth] - table[(y + boxHeight) * stride + x] + table[y * stride + x];
  const area = boxWidth * boxHeight;
  const score = (x, y) => {
    let sum = box(integral, x, y);
    // An eye holds dark and bright together - iris and sclera. An eyebrow is
    // dark on skin with nothing bright in it, and used to win on darkness
    // alone wherever the brows are heavier than the lashes.
    if (backing) sum *= clamp(box(backing, x, y) / (area * 1.5), 0.05, 1);
    return sum;
  };

  // Keep separate response peaks so a strong eyebrow cannot irrevocably win
  // before we have looked at the other eye. Four candidates bound the work.
  const candidates = [];
  const slackX = bandWidth - boxWidth;
  const slackY = bandHeight - boxHeight;
  const spread = (position, slack) => (slack > 1 ? Math.min(position, slack - position) / (slack / 2) : 1);
  for (let rank = 0; rank < candidateCount; rank += 1) {
    let best = 0, bestX = -1, bestY = -1;
    for (let y = 0; y <= slackY; y += 1) {
      for (let x = 0; x <= slackX; x += 1) {
        const cx = startX + x + boxWidth / 2, cy = startY + y + boxHeight / 2;
        if (candidates.some(c => Math.abs(c.windowX - cx) < boxWidth && Math.abs(c.windowY - cy) < boxHeight * 0.45)) continue;
        const value = score(x, y);
        if (value > best) { best = value; bestX = x; bestY = y; }
      }
    }
    if (bestX < 0) break;
    const centrality = Math.min(spread(bestX, slackX), spread(bestY, slackY));
    // A thin lip line or small iris can fit in many equally scoring windows.
    // Center on the actual ink rather than the first window visited.
    let mass = 0, momentX = 0, momentY = 0;
    for (let y = startY + bestY; y < startY + bestY + boxHeight; y += 1) {
      for (let x = startX + bestX; x < startX + bestX + boxWidth; x += 1) {
        const index = y * width + x, offset = index * 4;
        if (subjectMask[index] < 64) continue;
        const weight = Math.max(0, scoring(data[offset], data[offset + 1], data[offset + 2], x, y));
        mass += weight; momentX += (x + 0.5) * weight; momentY += (y + 0.5) * weight;
      }
    }
    candidates.push({
      x: candidateCount > 1 || !support ? momentX / mass : startX + bestX + boxWidth / 2,
      y: candidateCount > 1 || !support ? momentY / mass : startY + bestY + boxHeight / 2,
      windowX: startX + bestX + boxWidth / 2,
      windowY: startY + bestY + boxHeight / 2,
      height: boxHeight,
      strength: best / area,
      confidence: clamp(best / area / 55, 0.2, 0.88) * clamp(0.6 + 0.4 * centrality, 0.6, 1)
        + clamp(centrality * 0.22, 0, 0.22),
    });
  }
  return candidates.length ? { ...candidates[0], candidates } : { ...missed, candidates: [missed] };
}

export function estimateFeatures(imageData, subjectMask, face, proportions = PROPORTIONS.anime) {
  const { width, data } = imageData;
  const reach = Math.max(2, Math.round(face.width * 0.05));
  const skinAt = (x, y) => {
    const offset = (clamp(y, 0, imageData.height - 1) * width + clamp(x, 0, width - 1)) * 4;
    return isSkin(data[offset], data[offset + 1], data[offset + 2]);
  };
  const skinBeside = (x, y) => skinAt(x - reach, y) || skinAt(x + reach, y);
  // A mouth is a horizontal feature sitting in skin, so there is face above it
  // and below it. A lock of hair crossing the cheek has skin either side but
  // hair above and below, which is what kept winning the mouth band.
  const skinAboveAndBelow = (x, y, span) => skinAt(x, y - span) && skinAt(x, y + span);
  // Anime proportions: the eyes sit near the vertical middle of the head, not
  // in its upper third the way a photographic face does.
  // How bright is this character's skin? The sclera is what sits above it, and
  // that level differs enormously between a pale flat illustration and a
  // shaded anime face, so measure it rather than assuming a threshold.
  let skinTotal = 0;
  let skinCount = 0;
  for (let y = Math.max(0, Math.floor(face.y)); y < Math.min(imageData.height, face.y + face.height); y += 2) {
    for (let x = Math.max(0, Math.floor(face.x)); x < Math.min(width, face.x + face.width); x += 2) {
      const offset = (y * width + x) * 4;
      if (!isSkin(data[offset], data[offset + 1], data[offset + 2])) continue;
      skinTotal += luminance(data[offset], data[offset + 1], data[offset + 2]);
      skinCount += 1;
    }
  }
  const skinLevel = skinCount ? skinTotal / skinCount : 200;
  const scleraScore = (red, green, blue) => Math.max(0, luminance(red, green, blue) - (skinLevel + 8));

  const eyeBand = {
    x: face.x + face.width * 0.06,
    y: face.y + face.height * proportions.eyeBand[0],
    width: face.width * 0.88,
    height: face.height * proportions.eyeBand[1],
  };
  // Bangs are dark too, and there is a lot more of them than there is eyelash.
  // An eye has skin immediately beside it; a curtain of hair does not.
  const darkScore = (red, green, blue, x, y) =>
    skinBeside(x, y) ? Math.max(0, 150 - luminance(red, green, blue)) : 0;
  const leftSearch = { ...eyeBand, width: eyeBand.width * 0.48 };
  const rightSearch = {
    ...eyeBand,
    x: eyeBand.x + eyeBand.width * 0.52,
    width: eyeBand.width * 0.48,
  };
  const eyeWidth = face.width * proportions.eyeWindow[0];
  const eyeHeight = face.height * proportions.eyeWindow[1];
  const leftResponse = densestWindow(
    imageData, subjectMask, leftSearch, darkScore, eyeWidth, eyeHeight,
    face.x + face.width * 0.3, face.y + face.height * 0.45, scleraScore, proportions === PROPORTIONS.anime ? 4 : 1,
  );
  const rightResponse = densestWindow(
    imageData, subjectMask, rightSearch, darkScore, eyeWidth, eyeHeight,
    face.x + face.width * 0.7, face.y + face.height * 0.45, scleraScore, proportions === PROPORTIONS.anime ? 4 : 1,
  );
  let leftCenter = leftResponse, rightCenter = rightResponse;
  let pairScore = -Infinity;
  for (const left of leftResponse.candidates ?? [leftResponse]) {
    for (const right of rightResponse.candidates ?? [rightResponse]) {
      const spacing = right.x - left.x;
      if (spacing <= 0) continue;
      // Allow a tilted face, but penalize pairing an eyebrow with an eye.
      const tilt = Math.max(0, Math.abs(right.y - left.y) / spacing - 0.18);
      const drift = Math.abs((left.x + right.x) / 2 - face.x - face.width / 2) / face.width;
      const geometry = Math.exp(-80 * tilt * tilt - 3 * drift * drift);
      const evidence = Math.sqrt(left.strength * right.strength);
      const value = evidence * geometry;
      if (value > pairScore) { pairScore = value; leftCenter = left; rightCenter = right; }
    }
  }
  // Everything below is anchored on the eye pair rather than the face box. The
  // distance between the eyes is a stable fraction of an anime face, while the
  // skin region the box came from runs past the jaw whenever a collar or a bare
  // neck extends it - which is what used to put the mouth on the choker.
  const eyeMidX = (leftCenter.x + rightCenter.x) / 2;
  const eyeMidY = (leftCenter.y + rightCenter.y) / 2;
  const interocular = clamp(rightCenter.x - leftCenter.x, face.width * 0.3, face.width * 1.1);
  // A mouth sits about half an interocular distance below the eye line, on the
  // midline. Blush is red too, but it is out on the cheeks.
  const mouthSearch = {
    x: eyeMidX - interocular * proportions.mouthBand[0] / 2,
    y: eyeMidY + interocular * proportions.mouthDrop,
    width: interocular * proportions.mouthBand[0],
    height: interocular * proportions.mouthBand[1],
  };
  // Accept dark reddish lips and neutral ink, but reject cool-colored hair.
  // Blush covers much more area than a mouth, so retain the brightness gate
  // and require skin above and below the stroke.
  const mouthReach = Math.max(3, Math.round(interocular * 0.16));
  const mouthScore = (red, green, blue, x, y) => {
    const light = luminance(red, green, blue);
    // Anime lips are often a neutral ink stroke, with no red pigment at all.
    const neutralInk = Math.max(red, green, blue) - Math.min(red, green, blue) < 28 && light < 125;
    if ((!neutralInk && red <= blue * 1.15) || light > 165) return 0;
    if (!skinBeside(x, y) || !skinAboveAndBelow(x, y, mouthReach)) return 0;
    const redness = red - (green + blue) * 0.5;
    const ink = neutralInk ? (125 - light) * 0.65 : redness * 1.5 + (125 - light) * 0.2;
    // A cheek mark can be darker than the lips. Favor evidence near the eye
    // midline, without forbidding an off-center or asymmetric expression.
    const offset = (x - eyeMidX) / Math.max(1, interocular * 0.3);
    const vertical = (y - eyeMidY - interocular * (proportions.mouthDrop + 0.18)) / Math.max(1, interocular * 0.22);
    return Math.max(0, ink) * Math.exp(-offset * offset - vertical * vertical);
  };
  const mouthWidth = interocular * proportions.mouthSize[0];
  const mouthHeight = interocular * proportions.mouthSize[1];
  const mouthCenter = densestWindow(
    imageData, subjectMask, mouthSearch, mouthScore, mouthWidth, mouthHeight,
    face.x + face.width * 0.5, face.y + face.height * 0.7,
  );

  const rectangle = (center, width, height) => ({
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  });
  // The search window had to be sized from the face box, but the final rectangle
  // can use the measured eye separation, which is the better ruler.
  const finalEyeWidth = clamp(interocular * proportions.eyeSize[0], face.width * 0.1, face.width * 0.42);
  const finalEyeHeight = clamp(interocular * proportions.eyeSize[1], face.height * 0.05, face.height * 0.32);
  return {
    leftEye: { ...rectangle(leftCenter, finalEyeWidth, finalEyeHeight), confidence: leftCenter.confidence },
    rightEye: { ...rectangle(rightCenter, finalEyeWidth, finalEyeHeight), confidence: rightCenter.confidence },
    mouth: { ...rectangle(mouthCenter, mouthWidth, mouthHeight), confidence: mouthCenter.confidence },
  };
}

// Edge energy inside the face box. Blur destroys the very detail the feature
// search depends on, and nothing else in the score notices: a five pixel blur
// left confidence at 0.73 while the result fell to 0.39.
function faceSharpness(imageData, face) {
  const { width, height, data } = imageData;
  const step = Math.max(1, Math.round(Math.min(face.width, face.height) / 48));
  let total = 0;
  let count = 0;
  for (let y = Math.max(1, Math.floor(face.y)); y < Math.min(height - 1, face.y + face.height); y += step) {
    for (let x = Math.max(1, Math.floor(face.x)); x < Math.min(width - 1, face.x + face.width); x += step) {
      const at = (px, py) => {
        const offset = (py * width + px) * 4;
        return luminance(data[offset], data[offset + 1], data[offset + 2]);
      };
      total += Math.abs(at(x + 1, y) - at(x - 1, y)) + Math.abs(at(x, y + 1) - at(x, y - 1));
      count += 1;
    }
  }
  return count ? total / count : 0;
}

// Internal agreement. The two eyes should sit at the same height, straddle the
// face centre, and be a plausible distance apart. When they disagree at least
// one of them is wrong, and that is knowable without any ground truth.
function pairAgreement(face, features) {
  const { leftEye, rightEye } = features;
  const leftCentre = leftEye.x + leftEye.width / 2;
  const rightCentre = rightEye.x + rightEye.width / 2;
  const spacing = rightCentre - leftCentre;
  if (!(spacing > 0)) return 0.2;
  const level = 1 - clamp(Math.abs((leftEye.y + leftEye.height / 2) - (rightEye.y + rightEye.height / 2))
    / Math.max(1, leftEye.height), 0, 1);
  const drift = Math.abs((leftCentre + rightCentre) / 2 - (face.x + face.width / 2)) / Math.max(1, face.width);
  const centred = 1 - clamp(drift * 4, 0, 1);
  const spread = spacing / Math.max(1, face.width);
  const plausible = spread > 0.22 && spread < 0.78 ? 1 : 0.5;
  return clamp(0.4 + 0.6 * level * centred * plausible, 0.2, 1);
}

// The skin centroid is a poor midline: hair falling across one cheek, or an ear
// visible on one side only, shifts it while the eyes stay put. Recentring the
// face box horizontally on the eye pair costs nothing when the eyes were found
// well and fixes the whole downstream chain when they were not - every feature
// band is placed relative to this box.
//
// Only the horizontal centre. Reframing the box from the eye pair outright was
// measured and lost: it inherits whatever vertical bias the eye search has.
function recentreOnEyes(face, features, subjectBounds) {
  const { leftEye, rightEye } = features;
  if (Math.min(leftEye.confidence, rightEye.confidence) < 0.24) return face;
  const middle = (leftEye.x + leftEye.width / 2 + rightEye.x + rightEye.width / 2) / 2;
  const drift = middle - (face.x + face.width / 2);
  // A correction larger than this means the eyes are not where a face has eyes,
  // so trust the skin region instead of chasing them.
  if (Math.abs(drift) > face.width * 0.22) return face;
  return {
    ...face,
    x: clamp(face.x + drift, subjectBounds.x, subjectBounds.x + subjectBounds.width - face.width),
  };
}

export function analyzeImageData(imageData, style = 'anime') {
  const proportions = PROPORTIONS[style] ?? PROPORTIONS.anime;
  const extraction = extractSubjectMask(imageData);
  const subject = maskBounds(extraction.mask, imageData.width, imageData.height);
  const roughFace = estimateFace(imageData, extraction.mask, subject, proportions);
  const roughFeatures = estimateFeatures(imageData, extraction.mask, roughFace, proportions);
  const face = recentreOnEyes(roughFace, roughFeatures, subject);
  const features = face === roughFace
    ? roughFeatures
    : estimateFeatures(imageData, extraction.mask, face, proportions);
  const sharpness = faceSharpness(imageData, face);
  const agreement = pairAgreement(face, features);
  const detail = clamp(sharpness / 25, 0.3, 1);
  const confidence = (
    extraction.confidence * 0.22
    + face.confidence * 0.38
    + features.leftEye.confidence * 0.1
    + features.rightEye.confidence * 0.1
    + features.mouth.confidence * 0.2
  ) * agreement * detail;
  const warnings = [];
  if (extraction.mode === "full image fallback") {
    warnings.push("Background removal was uncertain; the original background was kept to preserve the character.");
  } else if (extraction.confidence < 0.45) warnings.push("Background removal was uncertain; inspect the silhouette.");
  if (face.confidence < 0.45) warnings.push("Face placement was uncertain; check the face outline before building.");
  if (face.method === "skin-region estimate" && face.height > subject.height * 0.45) {
    warnings.push("No neck was found, so the face may include the body. Move the face outline onto the head.");
  }
  if (Math.min(features.leftEye.confidence, features.rightEye.confidence) < 0.35) {
    warnings.push("One or both eye regions were estimated; inspect blink keyforms.");
  }
  if (features.mouth.confidence < 0.35) warnings.push("Mouth placement was estimated; inspect lip sync.");
  return { ...extraction, subject, face, features, confidence, warnings, sharpness, agreement,
    extraction: extraction.confidence, style: PROPORTIONS[style] ? style : 'anime' };
}

function canvasFor(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

async function decodeImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_ANALYSIS_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = canvasFor(bitmap.width * scale, bitmap.height * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { canvas, imageData: context.getImageData(0, 0, canvas.width, canvas.height) };
}

export async function prepareAutoRig(file, style = 'anime', { signal, detectLandmarks = true } = {}) {
  if (!file?.type?.startsWith("image/")) throw new Error("Please choose a PNG, WebP, or JPEG image.");
  const { imageData } = await decodeImage(file);
  let analysis = analyzeImageData(imageData, style);
  if (style === 'anime' && detectLandmarks) {
    try {
      analysis = applyAnimeLandmarks(analysis, await detectAnimeLandmarks(imageData, { signal }), imageData.width, imageData.height);
    } catch (error) {
      signal?.throwIfAborted();
      analysis.warnings.push(`Anime detector: ${error.message} Using estimated outlines.`);
    }
  }
  return { imageData, analysis, regions: addRegionContours(fitRegions(defaultRegions(analysis), imageData.width, imageData.height), imageData), name: file.name.replace(/\.[^.]+$/, "") || "Auto-rigged Puppet" };
}

export async function autoRigFile(file, { onProgress = () => {}, review = null, regions = null, signal = null, style = 'anime', faceOnly = false } = {}) {
  onProgress("Finding the character and features", 0.1);
  const prepared = await prepareAutoRig(file, style, { signal });
  signal?.throwIfAborted();
  onProgress("Review feature placement", 0.35);
  // The review may switch proportions, which re-estimates the whole analysis, so
  // it answers with { regions, analysis }. Older reviewers answered with the
  // regions alone; accept either, because getting this wrong lands as an
  // undefined deep inside the rig builder rather than as anything readable.
  const answer = regions ?? (review ? await review({ ...prepared, faceOnly }) : prepared.regions);
  const placement = answer?.regions ?? answer;
  const analysis = answer?.analysis ?? prepared.analysis;
  if (!placement?.face) {
    throw new Error("The placement review returned no regions. If this page has been open a while, reload it.");
  }
  onProgress("Separating artwork and building the rig", 0.6);
  await new Promise(resolve => requestAnimationFrame(resolve));
  signal?.throwIfAborted();
  const model = buildLayeredRig(prepared.imageData, analysis, placement, prepared.name, { faceOnly, preserveEyes: answer?.preserveEyes ?? true });
  const report = {
    confidence: analysis.confidence,
    proportions: PROPORTIONS[analysis.style ?? 'anime'].label,
    backgroundMode: analysis.mode,
    landmarkMethod: analysis.landmarkMethod ?? "Estimated landmarks",
    warnings: model.meta.autoRig.warnings,
    sourceSize: `${prepared.imageData.width}×${prepared.imageData.height}`,
    meshVertices: model.layers.reduce((sum,l)=>sum+l.mesh.vertices.length/2,0),
    keyforms: model.layers.reduce((sum,l)=>sum+Object.values(l.keyforms).reduce((n,k)=>n+k.length,0),0),
  };
  onProgress("Layered rig complete", 1);
  return { model, report };
}
