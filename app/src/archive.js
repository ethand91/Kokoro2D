import { MODEL_LIMITS, readStreamBytes } from "./import-limits.js";
import { readArtwork } from "./texture-source.js";
// Small ZIP container: PNG/WebP assets are already compressed, so exports use
// stored entries. Imports also support DEFLATE through the browser's native API.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const MAX_ARCHIVE_BYTES = MODEL_LIMITS.archiveBytes;
const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function validPath(name) {
  return name && !name.startsWith("/") && !name.includes("\\") && !name.split("/").some(p => p === ".." || p === "." || !p);
}
export function writeZip(entries) {
  const chunks = [], directory = [];
  let offset = 0;
  if (entries.size > 2048) throw new Error("Too many archive entries.");
  for (const [name, value] of entries) {
    if (!validPath(name)) throw new Error("Invalid archive path.");
    const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
    const path = encoder.encode(name), crc = crc32(bytes);
    const local = new Uint8Array(30 + path.length), view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
    view.setUint32(14, crc, true); view.setUint32(18, bytes.length, true); view.setUint32(22, bytes.length, true);
    view.setUint16(26, path.length, true); local.set(path, 30);
    const central = new Uint8Array(46 + path.length), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, bytes.length, true); cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, path.length, true); cv.setUint32(42, offset, true); central.set(path, 46);
    chunks.push(local, bytes); directory.push(central); offset += local.length + bytes.length;
  }
  const size = directory.reduce((n, v) => n + v.length, 0), end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.size, true); ev.setUint16(10, entries.size, true);
  ev.setUint32(12, size, true); ev.setUint32(16, offset, true);
  if (offset + size + 22 > MAX_ARCHIVE_BYTES) throw new Error("Archive exceeds 256 MiB.");
  const out = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const chunk of [...chunks, ...directory, end]) { out.set(chunk, at); at += chunk.length; }
  return out;
}
export async function readZip(input, { signal } = {}) {
  signal?.throwIfAborted();
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22) throw new Error("Invalid ZIP directory.");
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("Archive exceeds 256 MiB.");
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < Math.max(0, bytes.length - 65557)) throw new Error("Invalid ZIP directory.");
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true), expanded = 0;
  if (count > 2048 || at + size > end || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error("Unsupported ZIP directory.");
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    signal?.throwIfAborted();
    if (i && i % 16 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) throw new Error("Invalid ZIP entry.");
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true), packed = view.getUint32(at + 20, true), length = view.getUint32(at + 24, true);
    const nl = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    if (at + 46 + nl + extra + comment > end || local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new Error("Truncated ZIP entry.");
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nl));
    at += 46 + nl + extra + comment;
    if (name.endsWith("/")) continue;
    expanded += length;
    if (!validPath(name) || entries.has(name) || flags & 1 || expanded > MAX_ARCHIVE_BYTES || ![0, 8].includes(method)) throw new Error("Unsafe or unsupported ZIP entry.");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + packed > bytes.length) throw new Error("Truncated ZIP data.");
    let data = bytes.subarray(start, start + packed);
    if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      data = await readStreamBytes(stream, { signal, maximum: length, label: "ZIP expansion" });
    }
    if (data.length !== length || crc32(data) !== crc) throw new Error(`Corrupt ZIP asset: ${name}`);
    entries.set(name, data);
  }
  return entries;
}
export function bytesToDataUrl(bytes, type) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${type};base64,${btoa(binary)}`;
}
export async function assetBytes(src, options) {
  return readArtwork(src, options);
}
