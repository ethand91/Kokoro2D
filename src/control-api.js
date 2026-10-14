import { parseTimedVisemes } from "./audio-visemes.js";
import { readResponseBytes, parseJson } from "./import-limits.js";

export const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
export function validControlCommand(command) {
  try {
    if (!object(command) || new TextEncoder().encode(JSON.stringify(command)).length > MAX_COMMAND_BYTES) return false;
    switch (command.type) {
      case "parameters":
        return object(command.values) && Object.keys(command.values).length <= 128
          && Object.entries(command.values).every(([id, value]) => id.length <= 128 && !["__proto__", "constructor", "prototype"].includes(id) && typeof value === "number" && Number.isFinite(value))
          && (command.holdMs === undefined || (typeof command.holdMs === "number" && Number.isFinite(command.holdMs)));
      case "reset": return true;
      case "expression": return command.id === null || (typeof command.id === "string" && command.id.startsWith("expr.") && command.id.length <= 128);
      case "speech": return typeof command.text === "string" && command.text.length <= 4000;
      case "visemes": {
        if (!object(command.track)) return false;
        const entries = command.track.segments ?? command.track.mouthCues;
        if (!Array.isArray(entries) || entries.length > 512) return false;
        parseTimedVisemes(command.track); return true;
      }
      default: return false;
    }
  } catch { return false; }
}
export function parameterCommand(command, definitions) {
  if (!object(command) || command.type !== "parameters" || !object(command.values) || !object(definitions)) return null;
  try { if (new TextEncoder().encode(JSON.stringify(command)).length > MAX_COMMAND_BYTES) return null; } catch { return null; }
  // Preserve the public helper's per-value rejection for callers with mixed
  // valid/invalid values. Network commands are rejected as a whole upstream.
  const finiteValues = Object.fromEntries(Object.entries(command.values).filter(([, value]) => typeof value === "number" && Number.isFinite(value)));
  if (!validControlCommand({ ...command, values: finiteValues }) || Object.keys(command.values).length > 128) return null;
  const values = {};
  for (const [id, value] of Object.entries(command.values)) {
    const definition = Object.hasOwn(definitions, id) ? definitions[id] : null;
    if (typeof value === "number" && Number.isFinite(value) && definition && Number.isFinite(definition.min) && Number.isFinite(definition.max) && definition.min <= definition.max) {
      values[id] = Math.max(definition.min, Math.min(definition.max, value));
    }
  }
  return { values, holdMs: Math.max(50, Math.min(15000, command.holdMs ?? 500)) };
}
function validateBatch(result) {
  if (!object(result) || !Number.isSafeInteger(result.sequence) || result.sequence < 0 || !Array.isArray(result.events) || result.events.length > 256) throw new Error("Invalid control event batch.");
  let previous = -1;
  for (const event of result.events) {
    if (!object(event) || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence <= previous || event.sequence > result.sequence || !validControlCommand(event.command)) throw new Error("Invalid control event sequence or command.");
    previous = event.sequence;
  }
  return result;
}
export class ControlInbox {
  constructor(receive, { onError = () => {}, random = Math.random, requestTimeoutMs = 5000 } = {}) {
    Object.assign(this, { receive, onError, random, requestTimeoutMs, cursor: 0, active: false, session: null });
  }
  start() {
    if (this.session) return this.session.promise;
    const session = { controller: new AbortController() };
    this.session = session; this.active = true;
    session.promise = this.#poll(session);
    return session.promise;
  }
  async #poll(session) {
    const current = () => this.session === session && !session.controller.signal.aborted;
    let failures = 0;
    while (current()) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      session.controller.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, this.requestTimeoutMs);
      let delay = 80;
      try {
        const response = await fetch(`/api/control?after=${this.cursor}`, { signal: controller.signal, mode: "same-origin", redirect: "error" });
        const bytes = await readResponseBytes(response, { signal: controller.signal, maximum: MAX_RESPONSE_BYTES, label: "Control response" });
        const result = validateBatch(parseJson(new TextDecoder().decode(bytes), "Control response", MAX_RESPONSE_BYTES));
        if (!current()) break;
        if (result.sequence < this.cursor) this.cursor = 0; // Server restarted.
        for (const event of result.events) {
          if (!current()) break;
          if (event.sequence > this.cursor) {
            try { this.receive(event.command); } catch (error) { try { this.onError(error); } catch { /* Diagnostics cannot block later commands. */ } }
            if (current()) this.cursor = event.sequence;
          }
        }
        if (current()) this.cursor = result.sequence;
        failures = 0;
      } catch (error) {
        if (!current()) break;
        failures = Math.min(failures + 1, 5);
        delay = Math.min(2000, 250 * 2 ** (failures - 1)) * (.5 + this.random() * .5);
        try { this.onError(error); } catch { /* Diagnostics cannot wedge polling. */ }
      } finally {
        clearTimeout(timeout); session.controller.signal.removeEventListener("abort", abort);
      }
      if (current()) await new Promise(resolve => {
        session.wake = resolve;
        session.timer = setTimeout(resolve, delay);
      });
      session.wake = null;
    }
  }
  stop() {
    const session = this.session;
    if (!session) return;
    this.session = null; this.active = false;
    session.controller.abort(); clearTimeout(session.timer); session.wake?.();
  }
}
export async function sendControl(command) {
  if (!validControlCommand(command)) throw new Error("Invalid or oversized control command.");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch("/api/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command), signal: controller.signal, mode: "same-origin", redirect: "error" });
    if (!response.ok) throw new Error("Local controls unavailable.");
    await response.body?.cancel();
  } finally { clearTimeout(timer); }
}
