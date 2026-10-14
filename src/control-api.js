export function parameterCommand(command, definitions) {
  if (!command || command.type !== "parameters" || !command.values || typeof command.values !== "object") return null;
  const values = {};
  for (const [id, value] of Object.entries(command.values)) {
    const definition = definitions[id];
    if (definition && typeof value === "number" && Number.isFinite(value)) values[id] = Math.max(definition.min, Math.min(definition.max, value));
  }
  return { values, holdMs: Math.max(50, Math.min(15000, Number(command.holdMs) || 500)) };
}
export class ControlInbox {
  constructor(receive) { this.receive = receive; this.cursor = 0; this.active = true; this.controller = null; }
  async start() {
    while (this.active) {
      try {
        this.controller = new AbortController();
        const response = await fetch(`/api/control?after=${this.cursor}`, { signal: this.controller.signal });
        if (!response.ok) throw new Error("Controls unavailable.");
        const result = await response.json();
        if(result.sequence<this.cursor)this.cursor=0;
        for (const event of result.events) {
          if (this.active && event.sequence > this.cursor) { try { this.receive(event.command); } catch { /* Reject one command without wedging later controls. */ } }
          this.cursor = Math.max(this.cursor, event.sequence);
        }
        this.cursor = Math.max(this.cursor, result.sequence);
      } catch { /* A static host can still play models without the local API. */ }
      if (this.active) await new Promise(resolve => setTimeout(resolve, 80));
    }
  }
  stop() { this.active = false; this.controller?.abort(); }
}
export async function sendControl(command) {
  const response = await fetch("/api/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
  if (!response.ok) throw new Error("Local controls unavailable.");
}
