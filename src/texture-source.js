import { MODEL_LIMITS, readBlobBytes, readResponseBytes } from "./import-limits.js";

export const IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const DATA_HEADER = /^data:(image\/(?:png|jpeg|webp|svg\+xml))(;charset=utf-8)?(;base64)?,/i;

// Legacy models label local URL sources as "embedded" too. Preserve that meaning.
export function textureSource(src, base = globalThis.location?.href) {
  if (typeof src !== "string" || !src || /[\u0000-\u001f\u007f]/.test(src)) throw new Error("Artwork source must be a nonempty image URL without control characters.");
  if (src.startsWith("data:")) {
    const header = DATA_HEADER.exec(src);
    if (!header) throw new Error("Embedded artwork must be PNG, JPEG, WebP, or SVG image data.");
    const body = src.slice(header[0].length), base64 = Boolean(header[3]);
    const maximum = base64 ? Math.ceil(MODEL_LIMITS.imageBytes / 3) * 4 : MODEL_LIMITS.imageBytes * 3;
    if (!body || body.length > maximum) throw new Error("Embedded artwork exceeds 16 MiB or is empty.");
    if (base64 && (body.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body))) throw new Error("Embedded artwork has malformed base64 data.");
    if (!base64 && header[1].toLowerCase() !== "image/svg+xml") throw new Error("Raster artwork must use base64 encoding.");
    return { type: header[1].toLowerCase(), body, base64, embedded: true };
  }
  if (src.length > MODEL_LIMITS.stringLength || src.includes("\\") || src.trim() !== src) throw new Error("Artwork URL is invalid or too long.");
  // Resolve against the application, never against an imported model's metadata.
  const url = new URL(src, base ?? "https://kokoro.invalid/");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Artwork URLs must use HTTP(S), without credentials. Blob/file/script URLs are not portable model sources.");
  if (base && url.origin !== new URL(base).origin) throw new Error("External artwork must be served from the same origin as Kokoro2D. Embed remote artwork before importing.");
  // Node validation has no origin: only relative sources are portable by default.
  if (!base && (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith("//"))) throw new Error("External artwork must be a local relative URL or embedded image.");
  return { url: url.href, embedded: false };
}

export function dataImageBytes(source) {
  if (source.base64) {
    const binary = atob(source.body), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  try { return new TextEncoder().encode(decodeURIComponent(source.body)); }
  catch { throw new Error("Embedded SVG has invalid URL encoding."); }
}

export function checkImageDimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > MODEL_LIMITS.imageSide || height > MODEL_LIMITS.imageSide || width * height > MODEL_LIMITS.imagePixels) {
    throw new Error("Artwork dimensions must fit within 8192 px per side and 16 megapixels.");
  }
}

// Read container dimensions before asking the browser to allocate decoded pixels.
export function imageInfo(bytes, type) {
  if (!IMAGE_TYPES.includes(type) || !bytes.length || bytes.length > MODEL_LIMITS.imageBytes) throw new Error("Artwork must be PNG, JPEG, WebP or SVG, at most 16 MiB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at, count) => String.fromCharCode(...bytes.subarray(at, at + count));
  let width, height;
  if (type === "image/png" && bytes.length >= 33 && ascii(0, 8) === '\x89PNG\r\n\x1a\n' && ascii(12, 4) === "IHDR" && view.getUint32(8) === 13) {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (type === "image/webp" && bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    const uint24 = at => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
    if (kind === "VP8X") { width = uint24(24) + 1; height = uint24(27) + 1; }
    else if (kind === "VP8 " && ascii(23, 3) === '\x9d\x01\x2a') { width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383; }
    else if (kind === "VP8L" && bytes[20] === 0x2f) { const bits = view.getUint32(21, true); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1; }
  } else if (type === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    let at = 2;
    while (at + 3 < bytes.length) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) break;
      const size = view.getUint16(at);
      if (size < 2 || at + size > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && size >= 8) {
        height = view.getUint16(at + 3); width = view.getUint16(at + 5); break;
      }
      at += size;
    }
  } else if (type === "image/svg+xml") {
    // SVG is only ever decoded as an image, never inserted into a document.
    // Reject active content, nested resources, CSS and expansion declarations.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bytes.length > 1024 * 1024 || /<!DOCTYPE|<!ENTITY|<\?|<\s*(?:script|foreignObject|image|use|style|animate\w*|set|filter|fe\w*)\b|\bon[a-z]+\s*=|\b(?:href|src|style)\s*=|@import|&(?:#|[a-z])/i.test(text) || /url\(\s*(?!#[\w.-]+\))/i.test(text)) {
      throw new Error("SVG artwork must be static, self-contained shapes without scripts, styles, filters or external references.");
    }
    const root = /^\s*<svg\b([^>]*)>/i.exec(text);
    if (!root) throw new Error("SVG artwork needs an svg root with explicit dimensions.");
    const dimension = key => {
      const match = new RegExp(`\\b${key}\\s*=\\s*["'](\\d+(?:\\.\\d+)?)(?:px)?["']`, "i").exec(root[1]);
      return match ? Number(match[1]) : NaN;
    };
    width = dimension("width"); height = dimension("height");
  }
  if (!width || !height) throw new Error(`Invalid or unsupported ${type} artwork header.`);
  checkImageDimensions(width, height);
  return { width, height };
}

export async function readArtwork(src, { signal } = {}) {
  signal?.throwIfAborted();
  const source = textureSource(src);
  let bytes, type = source.type;
  if (source.embedded) bytes = dataImageBytes(source);
  else {
    const response = await fetch(source.url, { signal, credentials: "omit", mode: "same-origin", redirect: "error" });
    type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    bytes = await readResponseBytes(response, { signal, maximum: MODEL_LIMITS.imageBytes, label: "Artwork" });
  }
  signal?.throwIfAborted();
  const dimensions = imageInfo(bytes, type);
  return { bytes, type, ...dimensions };
}

export async function readArtworkFile(file, { signal } = {}) {
  const bytes = await readBlobBytes(file, { signal, maximum: MODEL_LIMITS.imageBytes, label: "Artwork" });
  return { bytes, type: file.type, ...imageInfo(bytes, file.type) };
}

export async function decodeArtwork(artwork, { signal } = {}) {
  signal?.throwIfAborted();
  const url = URL.createObjectURL(new Blob([artwork.bytes], { type: artwork.type }));
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      const finish = error => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        image.onload = image.onerror = null;
        if (error) { image.src = ""; reject(error); } else resolve(image);
      };
      const abort = () => finish(new DOMException("Artwork loading cancelled.", "AbortError"));
      const timer = setTimeout(() => finish(new Error("Artwork decoding timed out.")), 30000);
      image.onload = () => {
        try {
          checkImageDimensions(image.naturalWidth || image.width, image.naturalHeight || image.height);
          finish();
        } catch (error) { finish(error); }
      };
      image.onerror = () => finish(new Error("Unable to decode a layer image."));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else image.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}
