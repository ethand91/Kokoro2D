// Shared budgets for JSON, archives, artwork and renderer staging. No schema change.
export const MODEL_LIMITS = Object.freeze({
  fileBytes: 64 * 1024 * 1024,
  archiveBytes: 256 * 1024 * 1024,
  imageBytes: 16 * 1024 * 1024,
  embeddedBytes: 64 * 1024 * 1024,
  imageSide: 8192,
  imagePixels: 16 * 1024 * 1024,
  texturePixels: 64 * 1024 * 1024,
  layers: 256,
  groups: 64,
  parameters: 128,
  vertices: 16384,
  triangles: 32768,
  totalVertices: 250000,
  poseValues: 4000000,
  keysPerChannel: 64,
  correctives: 64,
  hierarchyDepth: 16,
  jsonDepth: 32,
  jsonValues: 8000000,
  stringLength: 4096,
  coordinate: 1000000,
});

export function checkFileSize(file, maximum = MODEL_LIMITS.fileBytes, label = "Model file") {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > maximum) {
    throw new Error(`${label} must be at most ${maximum / 1048576} MiB.`);
  }
}

export async function readBlobBytes(file, { signal, maximum = MODEL_LIMITS.fileBytes, label = "Model file" } = {}) {
  signal?.throwIfAborted();
  checkFileSize(file, maximum, label);
  return readStreamBytes(file.stream(), { signal, maximum, label });
}

export async function readStreamBytes(stream, { signal, maximum, label = "Download" }) {
  signal?.throwIfAborted();
  const reader = stream.getReader(), parts = [];
  let length = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new Error(`${label} exceeds ${maximum / 1048576} MiB.`);
      parts.push(value);
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
    return bytes;
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readResponseBytes(response, options) {
  if (!response.ok || !response.body) throw new Error(`${options.label ?? "Download"} could not be read (HTTP ${response.status}).`);
  const declared = Number(response.headers.get("content-length"));
  if (declared > options.maximum) {
    await response.body.cancel();
    throw new Error(`${options.label ?? "Download"} exceeds ${options.maximum / 1048576} MiB.`);
  }
  return readStreamBytes(response.body, options);
}

export function parseJson(text, label = "Model JSON", maximum = MODEL_LIMITS.fileBytes) {
  if (typeof text !== "string" || text.length > maximum || new TextEncoder().encode(text).length > maximum) {
    throw new Error(`${label} exceeds ${maximum / 1048576} MiB.`);
  }
  // Bound nesting before JSON.parse allocates the object graph; ignore delimiters in strings.
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (++depth > MODEL_LIMITS.jsonDepth) throw new Error(`${label} nesting exceeds ${MODEL_LIMITS.jsonDepth} levels.`);
    } else if (char === "}" || char === "]") depth--;
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} is malformed. Check its JSON syntax or export the model again.`); }
}
