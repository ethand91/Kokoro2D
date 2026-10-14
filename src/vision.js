// Optional helper: ask a local Ollama vision model which proportions preset the
// artwork wants. Nothing else here talks to a model, and nothing depends on
// this — if Ollama is not running the placement review simply keeps its manual
// selector. The artwork is posted to localhost and goes no further.
//
// This asks for a judgement, not a measurement, because that is the only part a
// general vision model does better than the geometry in auto-rigger.js. Measured
// against hand-marked truth on three drawings, qwen3.5:9b located facial
// features at 0.45 mean IoU against 0.61 for the heuristics, but it picked the
// right preset on all three, three runs each — provided it is asked to compare
// eye height to head height rather than to name an art style. Asked the latter
// it calls a flatly shaded realistic illustration "anime", which it is.
export const VISION_DEFAULTS = Object.freeze({
  endpoint: "http://localhost:11434",
  model: "qwen3.5:9b",
  maxSide: 640,
});

const PROMPT = `Ignore the art style, the colours and the subject. Judge only the
PROPORTIONS of this character's face.

Compare the height of ONE EYE to the height of the whole head (hairline to chin).

If one eye is taller than about a fifth of the head, answer {"style":"anime"}.
If one eye is much smaller than that - roughly a tenth of the head or less, as on
a real human face - answer {"style":"realistic"}.

Answer with ONLY the JSON object.`;

function encode(imageData, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(imageData.width, imageData.height));
  const source = Object.assign(document.createElement("canvas"), {
    width: imageData.width,
    height: imageData.height,
  });
  source.getContext("2d").putImageData(imageData, 0, 0);
  const target = Object.assign(document.createElement("canvas"), {
    width: Math.max(1, Math.round(imageData.width * scale)),
    height: Math.max(1, Math.round(imageData.height * scale)),
  });
  target.getContext("2d").drawImage(source, 0, 0, target.width, target.height);
  return target.toDataURL("image/png").split(",")[1];
}

export async function visionAvailable({ endpoint = VISION_DEFAULTS.endpoint } = {}) {
  try {
    const response = await fetch(`${endpoint}/api/version`);
    return response.ok;
  } catch {
    return false;
  }
}

// Resolves to "anime", "realistic", or null when the model is unreachable or
// answers with anything else. A null means "keep whatever the user chose".
export async function detectProportions(imageData, options = {}) {
  const { endpoint, model, maxSide } = { ...VISION_DEFAULTS, ...options };
  const response = await fetch(`${endpoint}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: options.signal ?? null,
    body: JSON.stringify({
      model,
      prompt: PROMPT,
      images: [encode(imageData, maxSide)],
      stream: false,
      format: "json",
      think: false,
      options: { temperature: 0 },
    }),
  });
  if (!response.ok) throw new Error(`${model} returned ${response.status}. Is it pulled?`);
  const { response: answer } = await response.json();
  const style = JSON.parse(answer)?.style;
  return style === "anime" || style === "realistic" ? style : null;
}
