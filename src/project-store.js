import { AUTOSAVE_KEY, validateModel } from "./model.js";
import { MODEL_LIMITS, parseJson } from "./import-limits.js";

// Artwork is interned once. Undo frames and IndexedDB revisions only reference
// asset keys; changing a vertex never copies megabytes of embedded PNG data.
export class SnapshotPool {
  constructor() { this.assets = new Map(); this.reverse = new Map(); }
  pack(saved) {
    return JSON.stringify(saved, (key, value) => {
      if (key !== "src" || typeof value !== "string") return value;
      let id = this.reverse.get(value);
      if (!id) { id = `asset:${this.assets.size}`; this.assets.set(id, value); this.reverse.set(value, id); }
      return { $asset: id };
    });
  }
  unpack(frame) {
    return JSON.parse(frame, (key, value) => {
      if (key !== "src" || !value?.$asset) return value;
      if (!this.assets.has(value.$asset)) throw new Error("Missing recovery artwork.");
      return this.assets.get(value.$asset);
    });
  }
}
let database;
function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open("kokoro2d-projects", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("assets"); request.result.createObjectStore("revisions");
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onclose = () => { database = null; };
      db.onversionchange = () => { db.close(); database = null; };
      resolve(db);
    };
    request.onerror = () => { database = null; reject(request.error); };
    request.onblocked = () => { blocked = true; database = null; reject(new Error("Recovery storage is blocked by another tab. Close it and retry.")); };
  });
  return database;
}
export class ProjectStore {
  constructor() { this.queue = Promise.resolve(); this.hashes = new Map(); this.sequence = 0; this.pending = 0; this.hashBytes = 0; }
  async save(saved) {
    validateSaved(saved);
    // Capture now, rather than after a later edit changes the live object.
    const pool = new SnapshotPool(), frame = pool.pack(saved), name = saved.model.meta.name;
    if (new TextEncoder().encode(frame).length > MODEL_LIMITS.fileBytes) throw new Error("Recovery snapshot exceeds 64 MiB.");
    if (this.pending >= 32) throw new Error("Recovery save queue is full. Wait for storage, then retry or export your project.");
    ++this.pending;
    const operation = this.queue.catch(() => {}).then(async () => {
      const db = await openDatabase(), assets = new Map();
      for (const [id, src] of pool.assets) {
        let hash = this.hashes.get(src);
        if (!hash) {
          hash = await assetHash(src);
          this.hashes.set(src, hash); this.hashBytes += src.length * 2;
          while (this.hashes.size > 512 || this.hashBytes > 32 * 1024 * 1024) {
            const oldest = this.hashes.keys().next().value;
            this.hashBytes -= oldest.length * 2; this.hashes.delete(oldest);
          }
        }
        assets.set(id, hash);
      }
      const data = JSON.stringify(JSON.parse(frame), (key, value) => key === "src" && value?.$asset ? { $asset: assets.get(value.$asset) } : value);
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(["assets", "revisions"], "readwrite");
        transaction.oncomplete = resolve;
        transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Recovery transaction aborted. Your previous save is preserved."));
        try {
          for (const [id, src] of pool.assets) transaction.objectStore("assets").put(src, assets.get(id));
          const revisions = transaction.objectStore("revisions"), stamp = Date.now();
          revisions.put({ frame: data, at: stamp, name }, "current");
          // Keep ten actual edits, including changes made within the same minute.
          revisions.put({ frame: data, at: stamp, name }, `backup:${stamp}:${String(this.sequence++).padStart(8,"0")}`);
          const request = revisions.getAllKeys();
          request.onsuccess = () => {
            request.result.filter(key => key !== "current").sort().slice(0, -10).forEach(key => revisions.delete(key));
            const retained=revisions.getAll();
            retained.onsuccess=()=>{
              const live=new Set();
              try {
                for (const revision of retained.result) parseJson(revision.frame, "Recovery snapshot");
                for (const revision of retained.result) JSON.parse(revision.frame, (key, value) => { if (key === "src" && value?.$asset) live.add(value.$asset); return value; });
              } catch { return; } // A corrupt retained revision must never trigger artwork deletion.
              const cursor=transaction.objectStore("assets").openKeyCursor();
              cursor.onsuccess=()=>{const current=cursor.result;if(!current)return;if(!live.has(current.key))transaction.objectStore("assets").delete(current.key);current.continue();};
            };
          };
        } catch (error) { transaction.abort(); reject(error); }
      });
    });
    this.queue = operation.finally(() => { --this.pending; }); return this.queue;
  }
  async revisions() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("revisions"), request = tx.objectStore("revisions").getAll();
      tx.oncomplete = () => resolve(request.result.filter((value,index,all)=>all.findIndex(v=>v.frame===value.frame)===index).sort((a, b) => b.at - a.at));
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Recovery history read aborted. Retry opening recovery."));
    });
  }
  async load(revision = null) {
    let db;
    try { db = await openDatabase(); }
    catch (error) {
      if (revision) throw error;
      const legacy = readLegacy();
      if (legacy) return legacy;
      throw error;
    }
    // Read revision and artwork in one transaction. A concurrent save/GC cannot
    // delete a referenced asset halfway through restoration.
    const snapshot = await new Promise((resolve, reject) => {
      const tx = db.transaction(["revisions", "assets"], "readonly");
      const request = tx.objectStore("revisions").get("current");
      const assets = new Map();
      request.onsuccess = () => {
        const saved = revision ?? request.result;
        if (!saved) return;
        try {
          const refs = new Set();
          const parsed = parseJson(saved.frame, "Recovery snapshot");
          JSON.stringify(parsed, (key, value) => { if (key === "src" && value?.$asset) refs.add(value.$asset); return value; });
          if (refs.size > MODEL_LIMITS.layers) throw new Error("Too many recovery assets.");
          for (const id of refs) {
            const asset = tx.objectStore("assets").get(id);
            asset.onsuccess = () => assets.set(id, asset.result);
          }
        } catch (error) { tx.abort(); reject(error); }
      };
      tx.oncomplete = () => resolve({ saved: revision ?? request.result, assets });
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Recovery read aborted. Retry opening the project."));
    });
    if (!snapshot.saved) {
      const legacy = readLegacy();
      if (legacy) {
        try { await this.save(legacy); }
        catch (error) { legacy.recoveryWarning = `Legacy recovery migration failed: ${error.message}. Export your project to keep it.`; }
      } // Keep legacy data until a new save succeeds.
      return legacy;
    }
    const parsed = parseJson(snapshot.saved.frame, "Recovery snapshot"), refs = new Set();
    JSON.parse(snapshot.saved.frame, (key, value) => { if (key === "src" && value?.$asset) refs.add(value.$asset); return value; });
    if (refs.size > MODEL_LIMITS.layers) throw new Error("Too many recovery assets.");
    const pool = new SnapshotPool();
    for (const id of refs) {
      const src = snapshot.assets.get(id);
      if (typeof src !== "string" || src.length > MODEL_LIMITS.imageBytes * 3) throw new Error("Missing recovery artwork. Try an older revision.");
      if (await assetHash(src) !== id) throw new Error("Corrupted recovery artwork. Try an older revision.");
      pool.assets.set(id, src);
    }
    const restored = pool.unpack(JSON.stringify(parsed));
    validateSaved(restored);
    return restored;
  }
}
function validateSaved(saved) {
  const errors = validateModel(saved?.model);
  if (errors.length) throw new Error(`Invalid recovery project: ${errors.join("\n")}`);
}
function readLegacy() {
  const raw = localStorage.getItem(AUTOSAVE_KEY);
  if (!raw) return null;
  const parsed = parseJson(raw, "Legacy recovery snapshot");
  if (parsed?.database === true && !parsed.model) return null;
  validateSaved(parsed);
  return parsed;
}
async function assetHash(src) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(src)))].map(value => value.toString(16).padStart(2, "0")).join("");
}
export const projectStore = new ProjectStore();
