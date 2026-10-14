import { readZip, writeZip, assetBytes, bytesToDataUrl } from "./archive.js";
import { clone, parseModel, validateModel } from "./model.js";
import { MODEL_LIMITS, checkFileSize, readBlobBytes, parseJson } from "./import-limits.js";
import { imageInfo } from "./texture-source.js";
import { validateJsonTree } from "./model-validation.js";

export async function portableModel(model, { signal } = {}) {
  signal?.throwIfAborted();
  const errors = validateModel(model);
  if (errors.length) throw new Error(errors.join("\n"));
  const portable = clone(model), seen = new Map();
  let totalBytes = 0, pixels = 0;
  for (const layer of portable.layers) {
    signal?.throwIfAborted();
    const src = layer.source.src;
    if (!seen.has(src)) {
      const asset = await assetBytes(src, { signal });
      totalBytes += asset.bytes.length; pixels += asset.width * asset.height;
      if (totalBytes > MODEL_LIMITS.embeddedBytes || pixels > MODEL_LIMITS.texturePixels) throw new Error("Project artwork exceeds 64 MiB or 64 megapixels.");
      seen.set(src, { ...asset, src: src.startsWith("data:") ? src : bytesToDataUrl(asset.bytes, asset.type) });
    }
    layer.source.src = seen.get(src).src;
    if (!src.startsWith("data:")) layer.source.type = "embedded";
  }
  signal?.throwIfAborted();
  return portable;
}

export async function exportProject(model, { signal } = {}) {
  const portable = await portableModel(model, { signal }), entries = new Map(), assets = {}, seen = new Map();
  for (const layer of portable.layers) {
    signal?.throwIfAborted();
    const src = layer.source.src;
    if (!seen.has(src)) {
      const { bytes, type } = await assetBytes(src, { signal });
      const path = `assets/${seen.size}.bin`;
      entries.set(path, bytes); assets[path] = { type }; seen.set(src, path);
    }
    layer.source.src = seen.get(src); layer.source.type = "archive";
  }
  entries.set("manifest.json", JSON.stringify({ format: "kokoro2d-project", version: 1, assets, model: portable }));
  return new Blob([writeZip(entries)], { type: "application/zip" });
}

export async function importProject(file, { signal } = {}) {
  checkFileSize(file, MODEL_LIMITS.archiveBytes, "Project file");
  const signature = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  signal?.throwIfAborted();
  const zipped = signature[0] === 0x50 && signature[1] === 0x4b;
  const bytes = await readBlobBytes(file, { signal, maximum: zipped ? MODEL_LIMITS.archiveBytes : MODEL_LIMITS.fileBytes, label: "Project file" });
  if (!zipped) return parseModel(new TextDecoder().decode(bytes));
  const entries = await readZip(bytes, { signal }), manifest = entries.get("manifest.json");
  if (!manifest) throw new Error("Missing project manifest.");
  if (manifest.length > MODEL_LIMITS.fileBytes) throw new Error("Project manifest exceeds 64 MiB.");
  const project = parseJson(new TextDecoder().decode(manifest), "Project manifest");
  validateJsonTree(project);
  if (project?.format !== "kokoro2d-project" || project.version !== 1 || !project.assets || typeof project.assets !== "object" || Array.isArray(project.assets)) throw new Error("Unsupported project container or asset table.");
  const model = project.model;
  const errors = validateModel(model, { archive: true });
  if (errors.length) throw new Error(errors.join("\n"));
  const resolved = new Map();
  let totalBytes = 0, pixels = 0;
  for (const layer of model.layers) {
    signal?.throwIfAborted();
    const path = layer.source.src;
    if (!resolved.has(path)) {
      const asset = Object.hasOwn(project.assets, path) ? project.assets[path] : null, data = entries.get(path);
      if (layer.source.type !== "archive" || !data || !asset) throw new Error(`Missing project artwork: ${path}`);
      const info = imageInfo(data, asset.type);
      totalBytes += data.length; pixels += info.width * info.height;
      if (totalBytes > MODEL_LIMITS.embeddedBytes || pixels > MODEL_LIMITS.texturePixels) throw new Error("Project artwork exceeds 64 MiB or 64 megapixels.");
      resolved.set(path, bytesToDataUrl(data, asset.type));
    }
    layer.source.src = resolved.get(path); layer.source.type = "embedded";
  }
  const finalErrors = validateModel(model);
  if (finalErrors.length) throw new Error(finalErrors.join("\n"));
  signal?.throwIfAborted();
  return model;
}
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
