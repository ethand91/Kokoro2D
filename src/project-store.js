import { AUTOSAVE_KEY, validateModel } from "./model.js";

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
      if (!value?.$asset) return value;
      if (!this.assets.has(value.$asset)) throw new Error("Missing recovery artwork.");
      return this.assets.get(value.$asset);
    });
  }
}
let database;
function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open("kokoro2d-projects", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("assets"); request.result.createObjectStore("revisions");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
export class ProjectStore {
  constructor() { this.queue = Promise.resolve(); this.hashes = new Map(); this.sequence = 0; }
  save(saved) {
    // Capture now, rather than after a later edit changes the live object.
    const pool = new SnapshotPool(), frame = pool.pack(saved), name = saved.model.meta.name;
    const operation = this.queue.catch(() => {}).then(async () => {
      const db = await openDatabase(), assets = new Map();
      for (const [id, src] of pool.assets) {
        let hash = this.hashes.get(src);
        if (!hash) {
          hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(src)))].map(v => v.toString(16).padStart(2, "0")).join("");
          if(this.hashes.size>=512)this.hashes.delete(this.hashes.keys().next().value);
          this.hashes.set(src,hash);
        }
        assets.set(id, hash);
      }
      const data = frame.replace(/"\$asset":"(asset:\d+)"/g, (_, id) => `"$asset":"${assets.get(id)}"`);
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(["assets", "revisions"], "readwrite");
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
            for(const revision of retained.result)JSON.parse(revision.frame,(_,value)=>{if(value?.$asset)live.add(value.$asset);return value;});
            const cursor=transaction.objectStore("assets").openKeyCursor();
            cursor.onsuccess=()=>{const current=cursor.result;if(!current)return;if(!live.has(current.key))transaction.objectStore("assets").delete(current.key);current.continue();};
          };
        };
        transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
      });
    });
    this.queue = operation; return operation;
  }
  async revisions() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction("revisions").objectStore("revisions").getAll();
      request.onsuccess = () => resolve(request.result.filter((value,index,all)=>all.findIndex(v=>v.frame===value.frame)===index).sort((a, b) => b.at - a.at)); request.onerror = () => reject(request.error);
    });
  }
  async load(revision = null) {
    let db;
    try { db = await openDatabase(); }
    catch(error) {
      if(revision)throw error;
      const legacy=JSON.parse(localStorage.getItem(AUTOSAVE_KEY)??"null");
      if(legacy?.model && !validateModel(legacy.model).length)return legacy;
      throw error;
    }
    const get = (store, key) => new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const saved = revision ?? await get("revisions", "current");
    if (!saved) {
      const legacy = localStorage.getItem(AUTOSAVE_KEY);
      const parsed=legacy?JSON.parse(legacy):null;
      return parsed?.model?parsed:null;
    }
    const parsed = JSON.parse(saved.frame), refs = new Set();
    JSON.parse(saved.frame, (_, value) => { if (value?.$asset) refs.add(value.$asset); return value; });
    const pool = new SnapshotPool();
    await Promise.all([...refs].map(async id => { const src = await get("assets", id); if (!src) throw new Error("Missing recovery artwork."); pool.assets.set(id, src); }));
    const restored = pool.unpack(JSON.stringify(parsed)), errors = validateModel(restored.model);
    if (errors.length) throw new Error(errors.join("\n"));
    return restored;
  }
}
export const projectStore = new ProjectStore();
