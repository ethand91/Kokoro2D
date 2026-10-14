import { readZip, bytesToDataUrl } from "./archive.js";
import { createModel, createLayer, uid } from "./model.js";

const modes = { "svg:src-over": "normal", "svg:multiply": "multiply", "svg:screen": "screen", "svg:overlay": "overlay" };
export async function importOpenRaster(file) {
  const entries = await readZip(await file.arrayBuffer());
  const stack = entries.get("stack.xml");
  if (!stack) throw new Error("Missing OpenRaster layer stack.");
  const text = new TextDecoder().decode(stack);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("Unsupported OpenRaster XML declarations.");
  const xml = new DOMParser().parseFromString(text, "application/xml");
  const image = xml.documentElement;
  if (image.tagName !== "image" || xml.querySelector("parsererror")) throw new Error("Invalid OpenRaster XML.");
  const width = Number(image.getAttribute("w")), height = Number(image.getAttribute("h"));
  if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192)) throw new Error("OpenRaster canvas must fit within 8192 × 8192.");
  const model = createModel(file.name.replace(/\.ora$/i, ""));
  model.canvas.width = width; model.canvas.height = height;
  let order = 0;
  const number = (el, attr, fallback) => {
    const value = el.hasAttribute(attr) ? Number(el.getAttribute(attr)) : fallback;
    if (!Number.isFinite(value)) throw new Error(`Invalid OpenRaster ${attr}.`);
    return value;
  };
  async function visit(stack, parent = null) {
    for (const el of [...stack.children].reverse()) {
      const mode = el.getAttribute("composite-op") ?? "svg:src-over";
      if (!modes[mode]) throw new Error(`Unsupported OpenRaster blend mode: ${mode}.`);
      if (el.tagName === "stack") {
        // Isolated groups preserve paint-tool opacity at overlapping pixels.
        if (el.getAttribute("isolation") === "auto") throw new Error("Convert pass-through groups to isolated groups before importing.");
        const group = { id: uid("group"), name: el.getAttribute("name") || "Group", parent, zIndex: order++, opacity: number(el, "opacity", 1), visible: el.getAttribute("visibility") !== "hidden", blendMode: modes[mode] };
        model.groups.push(group); await visit(el, group.id);
      } else if (el.tagName === "layer") {
        const data = entries.get(el.getAttribute("src"));
        if (!data) throw new Error("Missing OpenRaster layer image.");
        const src = bytesToDataUrl(data, "image/png"), bitmap = await createImageBitmap(new Blob([data], { type: "image/png" }));
        if (bitmap.width * bitmap.height > 32 * 1024 * 1024) { bitmap.close(); throw new Error("OpenRaster layer is too large."); }
        const layer = createLayer({ name: el.getAttribute("name") || "Layer", src, width: bitmap.width, height: bitmap.height,
          x: number(el, "x", 0) + bitmap.width / 2 - width / 2, y: number(el, "y", 0) + bitmap.height / 2 - height / 2, zIndex: order++ });
        layer.group = parent; layer.blendMode = modes[mode]; layer.transform.opacity = number(el, "opacity", 1); layer.visible = el.getAttribute("visibility") !== "hidden";
        model.layers.push(layer); bitmap.close();
      } else throw new Error(`Unsupported OpenRaster element: ${el.tagName}.`);
    }
  }
  const root = image.querySelector(":scope > stack"); if (!root) throw new Error("Missing OpenRaster root stack.");
  await visit(root); return model;
}
