import { createLayer, createModel, ensureKeyform } from "./model.js";

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
  return points.map(([x, y]) => {
    const offset = (y * width + x) * 4;
    return [data[offset], data[offset + 1], data[offset + 2]];
  });
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
  const background = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  const enqueue = (index) => {
    if (background[index]) return;
    const offset = index * 4;
    const distance = Math.min(...palette.map((color) => colorDistance(data, offset, color)));
    if (distance > 48) return;
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
    confidence: clamp(1 - Math.abs(ratio - 0.48) * 0.75, 0.48, 0.88),
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
  let best = null;
  for (let y = Math.floor(subjectBounds.y); y <= searchBottom; y += 1) {
    for (let x = Math.floor(subjectBounds.x); x < subjectBounds.x + subjectBounds.width; x += 1) {
      const seed = y * width + x;
      if (candidates[seed] !== 1) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = seed;
      candidates[seed] = 2;
      const component = {
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
          queue[tail++] = neighbor;
        }
      }
      const componentWidth = component.maximumX - component.minimumX + 1;
      const componentHeight = component.maximumY - component.minimumY + 1;
      const centerX = component.sumX / component.count;
      const centerY = component.sumY / component.count;
      const horizontalCentering = clamp(1 - Math.abs(centerX - (subjectBounds.x + subjectBounds.width / 2)) / subjectBounds.width, 0.35, 1);
      const upperWeight = clamp(1.35 - (centerY - subjectBounds.y) / subjectBounds.height, 0.4, 1.25);
      const aspect = componentWidth / Math.max(1, componentHeight);
      const aspectWeight = aspect >= 0.45 && aspect <= 1.8 ? 1 : 0.45;
      component.score = component.count * horizontalCentering * upperWeight * aspectWeight;
      if (!best || component.score > best.score) best = component;
    }
  }
  return best ?? {
    count: 0, sumX: 0, sumY: 0,
    minimumX: width, minimumY: height, maximumX: -1, maximumY: -1,
  };
}

export function estimateFace(imageData, subjectMask, subjectBounds) {
  const skin = skinBounds(imageData, subjectMask, subjectBounds);
  const subjectArea = subjectBounds.width * subjectBounds.height;
  const usableSkin = skin.count > subjectArea * 0.018;
  if (usableSkin) {
    const centerX = skin.sumX / skin.count;
    const centerY = skin.sumY / skin.count;
    const skinWidth = skin.maximumX - skin.minimumX + 1;
    const skinHeight = skin.maximumY - skin.minimumY + 1;
    const faceWidth = clamp(skinWidth * 1.12, subjectBounds.width * 0.28, subjectBounds.width * 0.68);
    const faceHeight = clamp(skinHeight * 1.08, faceWidth * 0.82, faceWidth * 1.35);
    return {
      x: clamp(centerX - faceWidth / 2, subjectBounds.x, subjectBounds.x + subjectBounds.width - faceWidth),
      y: clamp(centerY - faceHeight * 0.48, subjectBounds.y, subjectBounds.y + subjectBounds.height * 0.58),
      width: faceWidth,
      height: faceHeight,
      confidence: clamp(skin.count / (faceWidth * faceHeight) * 1.6, 0.42, 0.9),
      method: "skin-region estimate",
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

function weightedFeatureCenter(imageData, subjectMask, bounds, scoring, fallbackX, fallbackY) {
  const { width, height, data } = imageData;
  const startX = clamp(Math.floor(bounds.x), 0, width - 1);
  const endX = clamp(Math.ceil(bounds.x + bounds.width), 0, width);
  const startY = clamp(Math.floor(bounds.y), 0, height - 1);
  const endY = clamp(Math.ceil(bounds.y + bounds.height), 0, height);
  let total = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const index = y * width + x;
      if (subjectMask[index] < 64) continue;
      const offset = index * 4;
      const score = scoring(data[offset], data[offset + 1], data[offset + 2]);
      if (score <= 0) continue;
      total += score;
      sumX += x * score;
      sumY += y * score;
    }
  }
  const area = Math.max(1, (endX - startX) * (endY - startY));
  return {
    x: total > 0 ? sumX / total : fallbackX,
    y: total > 0 ? sumY / total : fallbackY,
    confidence: clamp(total / area / 65, 0.2, 0.88),
  };
}

export function estimateFeatures(imageData, subjectMask, face) {
  const eyeBand = {
    x: face.x + face.width * 0.06,
    y: face.y + face.height * 0.2,
    width: face.width * 0.88,
    height: face.height * 0.38,
  };
  const darkScore = (red, green, blue) => Math.max(0, 150 - luminance(red, green, blue));
  const leftSearch = { ...eyeBand, width: eyeBand.width * 0.48 };
  const rightSearch = {
    ...eyeBand,
    x: eyeBand.x + eyeBand.width * 0.52,
    width: eyeBand.width * 0.48,
  };
  const leftCenter = weightedFeatureCenter(
    imageData, subjectMask, leftSearch, darkScore,
    face.x + face.width * 0.3, face.y + face.height * 0.4,
  );
  const rightCenter = weightedFeatureCenter(
    imageData, subjectMask, rightSearch, darkScore,
    face.x + face.width * 0.7, face.y + face.height * 0.4,
  );

  const mouthSearch = {
    x: face.x + face.width * 0.22,
    y: face.y + face.height * 0.57,
    width: face.width * 0.56,
    height: face.height * 0.27,
  };
  const mouthScore = (red, green, blue) => {
    const redness = red - (green + blue) * 0.5;
    return Math.max(0, redness * 1.5 + (125 - luminance(red, green, blue)) * 0.35);
  };
  const mouthCenter = weightedFeatureCenter(
    imageData, subjectMask, mouthSearch, mouthScore,
    face.x + face.width * 0.5, face.y + face.height * 0.7,
  );

  const eyeWidth = face.width * 0.34;
  const eyeHeight = face.height * 0.18;
  const mouthWidth = face.width * 0.38;
  const mouthHeight = face.height * 0.17;
  const rectangle = (center, width, height) => ({
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  });
  return {
    leftEye: { ...rectangle(leftCenter, eyeWidth, eyeHeight), confidence: leftCenter.confidence },
    rightEye: { ...rectangle(rightCenter, eyeWidth, eyeHeight), confidence: rightCenter.confidence },
    mouth: { ...rectangle(mouthCenter, mouthWidth, mouthHeight), confidence: mouthCenter.confidence },
  };
}

export function analyzeImageData(imageData) {
  const extraction = extractSubjectMask(imageData);
  const subject = maskBounds(extraction.mask, imageData.width, imageData.height);
  const face = estimateFace(imageData, extraction.mask, subject);
  const features = estimateFeatures(imageData, extraction.mask, face);
  const confidence = (
    extraction.confidence * 0.3
    + face.confidence * 0.35
    + features.leftEye.confidence * 0.1
    + features.rightEye.confidence * 0.1
    + features.mouth.confidence * 0.15
  );
  const warnings = [];
  if (extraction.confidence < 0.45) warnings.push("Background removal was uncertain; inspect the silhouette.");
  if (face.confidence < 0.45) warnings.push("Face placement used a composition fallback.");
  if (Math.min(features.leftEye.confidence, features.rightEye.confidence) < 0.35) {
    warnings.push("One or both eye regions were estimated; inspect blink keyforms.");
  }
  if (features.mouth.confidence < 0.35) warnings.push("Mouth placement was estimated; inspect lip sync.");
  return { ...extraction, subject, face, features, confidence, warnings };
}

function canvasFor(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function copyMaskedCrop(imageData, mask, bounds) {
  const x = clamp(Math.floor(bounds.x), 0, imageData.width - 1);
  const y = clamp(Math.floor(bounds.y), 0, imageData.height - 1);
  const width = clamp(Math.ceil(bounds.width), 1, imageData.width - x);
  const height = clamp(Math.ceil(bounds.height), 1, imageData.height - y);
  const canvas = canvasFor(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const crop = context.createImageData(width, height);
  for (let cropY = 0; cropY < height; cropY += 1) {
    for (let cropX = 0; cropX < width; cropX += 1) {
      const sourceIndex = (y + cropY) * imageData.width + x + cropX;
      const sourceOffset = sourceIndex * 4;
      const targetOffset = (cropY * width + cropX) * 4;
      crop.data[targetOffset] = imageData.data[sourceOffset];
      crop.data[targetOffset + 1] = imageData.data[sourceOffset + 1];
      crop.data[targetOffset + 2] = imageData.data[sourceOffset + 2];
      crop.data[targetOffset + 3] = imageData.data[sourceOffset + 3] * mask[sourceIndex] / 255;
    }
  }
  context.putImageData(crop, 0, 0);
  return { canvas, x, y, width, height };
}

function eyelidCrop(imageData, bounds) {
  const x = clamp(Math.floor(bounds.x), 0, imageData.width - 1);
  const y = clamp(Math.floor(bounds.y), 0, imageData.height - 1);
  const width = clamp(Math.ceil(bounds.width), 1, imageData.width - x);
  const height = clamp(Math.ceil(bounds.height), 1, imageData.height - y);
  const canvas = canvasFor(width, height);
  const context = canvas.getContext("2d");
  const skin = averageSkinAround(imageData, bounds);
  context.save();
  context.translate(width / 2, height / 2);
  context.scale(1, 0.48);
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, width * 0.52);
  gradient.addColorStop(0, `rgba(${skin[0]}, ${skin[1]}, ${skin[2]}, 1)`);
  gradient.addColorStop(0.72, `rgba(${skin[0]}, ${skin[1]}, ${skin[2]}, 1)`);
  gradient.addColorStop(1, `rgba(${skin[0]}, ${skin[1]}, ${skin[2]}, 0)`);
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(0, 0, width * 0.52, 0, Math.PI * 2);
  context.fill();
  context.restore();
  context.strokeStyle = "rgba(58, 36, 70, .88)";
  context.lineWidth = Math.max(2, width * 0.025);
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(width * 0.18, height * 0.53);
  context.quadraticCurveTo(width * 0.5, height * 0.68, width * 0.82, height * 0.53);
  context.stroke();
  return { canvas, x, y, width, height };
}

function mouthInteriorCrop(imageData, bounds) {
  const x = clamp(Math.floor(bounds.x), 0, imageData.width - 1);
  const y = clamp(Math.floor(bounds.y), 0, imageData.height - 1);
  const width = clamp(Math.ceil(bounds.width), 1, imageData.width - x);
  const height = clamp(Math.ceil(bounds.height), 1, imageData.height - y);
  const canvas = canvasFor(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#672342";
  context.beginPath();
  context.ellipse(width / 2, height / 2, width * 0.36, height * 0.33, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#e778a4";
  context.beginPath();
  context.ellipse(width / 2, height * 0.62, width * 0.24, height * 0.12, 0, 0, Math.PI * 2);
  context.fill();
  return { canvas, x, y, width, height };
}

function averageSkinAround(imageData, bounds) {
  const { width, height, data } = imageData;
  const margin = Math.max(3, Math.round(Math.min(bounds.width, bounds.height) * 0.24));
  let count = 0;
  const color = [0, 0, 0];
  for (let y = Math.floor(bounds.y - margin); y <= Math.ceil(bounds.y + bounds.height + margin); y += 1) {
    for (let x = Math.floor(bounds.x - margin); x <= Math.ceil(bounds.x + bounds.width + margin); x += 1) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const inside = x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
      if (inside) continue;
      const offset = (y * width + x) * 4;
      if (!isSkin(data[offset], data[offset + 1], data[offset + 2])) continue;
      color[0] += data[offset];
      color[1] += data[offset + 1];
      color[2] += data[offset + 2];
      count += 1;
    }
  }
  if (!count) return [238, 190, 190];
  return color.map((channel) => Math.round(channel / count));
}

function addTransformKey(layer, parameterId, value, transform) {
  Object.assign(ensureKeyform(layer, parameterId, value).transform, transform);
}

function addWarpKey(layer, parameterId, value, warp) {
  const key = ensureKeyform(layer, parameterId, value);
  const { columns, rows, vertices } = layer.mesh;
  for (let index = 0; index < vertices.length; index += 2) {
    const vertex = index / 2;
    const column = vertex % (columns + 1);
    const row = Math.floor(vertex / (columns + 1));
    const normalizedX = column / columns;
    const normalizedY = row / rows;
    const [offsetX, offsetY] = warp(normalizedX, normalizedY, vertices[index], vertices[index + 1]);
    key.offsets[index] = offsetX;
    key.offsets[index + 1] = offsetY;
  }
}

function addHeadAndBodyWarp(layer, analysis, subjectBounds, displayWidth, displayHeight) {
  const faceCenterX = ((analysis.face.x + analysis.face.width / 2 - subjectBounds.x) / subjectBounds.width);
  const faceCenterY = ((analysis.face.y + analysis.face.height / 2 - subjectBounds.y) / subjectBounds.height);
  const faceRadiusX = analysis.face.width / subjectBounds.width * 0.78;
  const faceRadiusY = analysis.face.height / subjectBounds.height * 0.78;
  const headWeight = (u, v) => {
    const dx = (u - faceCenterX) / Math.max(0.12, faceRadiusX);
    const dy = (v - faceCenterY) / Math.max(0.12, faceRadiusY);
    return clamp(1 - Math.sqrt(dx * dx + dy * dy), 0, 1) ** 0.55;
  };
  for (const direction of [-1, 1]) {
    addWarpKey(layer, "head.yaw", direction, (u, v) => {
      const weight = headWeight(u, v);
      return [direction * (25 + (v - faceCenterY) * 10) * weight, direction * (u - faceCenterX) * 8 * weight];
    });
    addWarpKey(layer, "head.pitch", direction, (u, v) => {
      const weight = headWeight(u, v);
      return [0, direction * 19 * weight];
    });
    addWarpKey(layer, "head.roll", direction, (u, v, x, y) => {
      const weight = headWeight(u, v);
      const centerX = (faceCenterX - 0.5) * displayWidth;
      const centerY = (faceCenterY - 0.5) * displayHeight;
      const angle = direction * 0.09 * weight;
      const dx = x - centerX;
      const dy = y - centerY;
      return [dx * Math.cos(angle) - dy * Math.sin(angle) - dx, dx * Math.sin(angle) + dy * Math.cos(angle) - dy];
    });
    addWarpKey(layer, "body.sway", direction, (u, v) => {
      const weight = clamp((v - faceCenterY) / Math.max(0.1, 1 - faceCenterY), 0, 1);
      return [direction * 28 * weight, direction * (u - 0.5) * 5 * weight];
    });
    addWarpKey(layer, "hair.motion", direction, (u, v) => {
      const upper = clamp((0.72 - v) / 0.72, 0, 1);
      const edge = clamp(Math.abs(u - 0.5) * 2, 0, 1);
      const weight = upper * (0.25 + edge * 0.75) * (1 - headWeight(u, v) * 0.42);
      return [direction * (10 + v * 22) * weight, Math.abs(direction) * edge * 3 * weight];
    });
  }
}

function addHeadFollower(layer) {
  for (const direction of [-1, 1]) {
    addTransformKey(layer, "head.yaw", direction, { x: direction * 24, rotation: direction * 0.018 });
    addTransformKey(layer, "head.pitch", direction, { y: direction * 18 });
    addTransformKey(layer, "head.roll", direction, { rotation: direction * 0.09 });
  }
}

function addEyelidMotion(layer) {
  addHeadFollower(layer);
  layer.transform.opacity = 0;
  addTransformKey(layer, "eyes.blink", 1, { opacity: 1 });
}

function addMouthMotion(layer) {
  addHeadFollower(layer);
  layer.transform.opacity = 0;
  layer.transform.scaleY = 0.28;
  addTransformKey(layer, "mouth.open", 0.12, { opacity: 0 });
  addTransformKey(layer, "mouth.open", 1, { opacity: 1, scaleY: 0.72 });
  addTransformKey(layer, "mouth.form", -1, { scaleX: -0.22 });
  addTransformKey(layer, "mouth.form", 1, { scaleX: 0.25 });
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

function cropToLayer(crop, name, subjectBounds, modelScale, zIndex, columns, rows) {
  const displayWidth = crop.width * modelScale;
  const displayHeight = crop.height * modelScale;
  return createLayer({
    name,
    src: crop.canvas.toDataURL("image/png"),
    width: displayWidth,
    height: displayHeight,
    columns,
    rows,
    x: (crop.x + crop.width / 2 - (subjectBounds.x + subjectBounds.width / 2)) * modelScale,
    y: (crop.y + crop.height / 2 - (subjectBounds.y + subjectBounds.height / 2)) * modelScale,
    zIndex,
  });
}

export async function autoRigFile(file, { onProgress = () => {} } = {}) {
  if (!file?.type?.startsWith("image/")) throw new Error("Please choose a PNG, WebP, or JPEG image.");
  onProgress("Decoding artwork", 0.08);
  const { imageData } = await decodeImage(file);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  onProgress("Finding the character silhouette", 0.24);
  const analysis = analyzeImageData(imageData);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  onProgress("Locating face, eyes, and mouth", 0.42);

  const subjectBounds = analysis.subject;
  const modelScale = Math.min(900 / subjectBounds.height, 840 / subjectBounds.width);
  const displayWidth = subjectBounds.width * modelScale;
  const displayHeight = subjectBounds.height * modelScale;
  const baseCrop = copyMaskedCrop(imageData, analysis.mask, subjectBounds);
  const leftEyelidCrop = eyelidCrop(imageData, analysis.features.leftEye);
  const rightEyelidCrop = eyelidCrop(imageData, analysis.features.rightEye);
  const mouthCrop = mouthInteriorCrop(imageData, analysis.features.mouth);

  onProgress("Reconstructing blink surfaces", 0.58);
  await new Promise((resolve) => requestAnimationFrame(resolve));

  onProgress("Generating meshes and keyforms", 0.74);
  const modelName = file.name.replace(/\.[^.]+$/, "") || "Auto-rigged Puppet";
  const model = createModel(modelName);
  model.meta.generator = "Kokoro2D Full Auto Rigger 0.1.0";
  model.meta.autoRig = {
    version: 1,
    sourceName: file.name,
    analyzedAt: new Date().toISOString(),
    confidence: Number(analysis.confidence.toFixed(3)),
    backgroundMode: analysis.mode,
    faceMethod: analysis.face.method,
    warnings: analysis.warnings,
  };
  model.canvas = { width: 1000, height: 1000, background: "#1b1126" };

  const baseLayer = cropToLayer(baseCrop, "Auto Subject", subjectBounds, modelScale, 0, 10, 12);
  addHeadAndBodyWarp(baseLayer, analysis, subjectBounds, displayWidth, displayHeight);
  const leftEyelid = cropToLayer(leftEyelidCrop, "Left Eyelid", subjectBounds, modelScale, 1, 3, 2);
  const rightEyelid = cropToLayer(rightEyelidCrop, "Right Eyelid", subjectBounds, modelScale, 2, 3, 2);
  const mouth = cropToLayer(mouthCrop, "Mouth Interior", subjectBounds, modelScale, 3, 4, 2);
  addEyelidMotion(leftEyelid);
  addEyelidMotion(rightEyelid);
  addMouthMotion(mouth);
  model.layers.push(baseLayer, leftEyelid, rightEyelid, mouth);

  onProgress("Polishing the tiny performer", 0.92);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  onProgress("Auto-rig complete", 1);
  return {
    model,
    report: {
      confidence: analysis.confidence,
      backgroundMode: analysis.mode,
      faceMethod: analysis.face.method,
      warnings: analysis.warnings,
      sourceSize: `${imageData.width}×${imageData.height}`,
      meshVertices: model.layers.reduce((total, layer) => total + layer.mesh.vertices.length / 2, 0),
      keyforms: model.layers.reduce(
        (total, layer) => total + Object.values(layer.keyforms).reduce((sum, keys) => sum + keys.length, 0),
        0,
      ),
    },
  };
}
