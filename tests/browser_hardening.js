// Executed inside a real browser by browser_hardening.py (not a Node mock).
export async function runHardeningChecks() {
  const { ProjectStore, SnapshotPool } = await import("/src/project-store.js");
  const { createModel, createLayer, AUTOSAVE_KEY } = await import("/src/model.js");
  const { KokoroRenderer } = await import("/src/renderer.js");
  const { importProject, exportProject } = await import("/src/project-file.js");
  const { StageRecorder, recordingSupported } = await import("/src/recorder.js");
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const rejects = async (operation, pattern) => {
    try { await operation(); } catch (error) { assert(pattern.test(error.message), error.message); return; }
    throw new Error("Expected rejection: " + pattern);
  };
  const art = document.createElement("canvas"); art.width = art.height = 16;
  art.getContext("2d").fillRect(0, 0, 16, 16);
  const model = createModel("Hardening fixture");
  model.layers.push(createLayer({ name: "Paint", src: art.toDataURL(), width: 64, height: 64 }));
  model.layers.push({ ...structuredClone(model.layers[0]), id: "shared" });
  const saved = { model, selectedLayerId: model.layers[0].id };
  const pool = new SnapshotPool(); assert(pool.unpack(pool.pack(saved)).model.layers[0].source.src === model.layers[0].source.src, "snapshot artwork");
  await rejects(() => importProject(new Blob(['{"layers":null}'])), /schema|model|Model|version/);
  assert((await importProject(await exportProject(model))).layers.length === 2, "archive roundtrip");
  const canvas = document.createElement("canvas"); canvas.style.cssText = "width:128px;height:128px"; document.body.append(canvas);
  const renderer = new KokoroRenderer(canvas);
  for (let i = 0; i < 30; i++) { await renderer.setModel(model); renderer.render({ "eyes.blink": i % 2 }); assert(renderer.textures.size === 1, "shared texture"); }
  await rejects(() => renderer.setModel({}), /schema|model|Model|version/); assert(renderer.model === model, "malformed model replaced valid model");
  const extension = renderer.gl.getExtension("WEBGL_lose_context"); assert(extension, "context loss extension unavailable");
  const event = type => Promise.race([new Promise(resolve => renderer.addEventListener(type, resolve, { once: true })), new Promise((_, reject) => setTimeout(() => reject(new Error(type + " timed out")), 10000))]);
  let pending = event("contextlost"); extension.loseContext(); await pending;
  await new Promise(resolve => setTimeout(resolve, 150)); pending = event("contextrestored"); extension.restoreContext(); await pending;
  renderer.render({}); assert(renderer.available && renderer.gl.getError() === 0, "graphics recovery");
  assert(recordingSupported(), "WebM recording unavailable");
  const recorder = new StageRecorder(canvas); recorder.start();
  for (let i = 0; i < 12; i++) { renderer.render({}); recorder.frame(); await new Promise(resolve => setTimeout(resolve, 30)); }
  const stream = recorder.stream, recording = await recorder.stop();
  assert(recording?.size > 0 && stream.getVideoTracks().every(track => track.readyState === "ended"), "recording cleanup/export");
  renderer.dispose(); canvas.remove();
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open("kokoro2d-projects", 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); r.onupgradeneeded = () => { r.result.createObjectStore("assets"); r.result.createObjectStore("revisions"); }; });
  const transaction = (stores, action) => new Promise((resolve, reject) => { const tx = db.transaction(stores, "readwrite"); action(tx); tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); });
  await transaction(["assets", "revisions"], tx => { tx.objectStore("assets").clear(); tx.objectStore("revisions").clear(); });
  const store = new ProjectStore(); await store.save(saved);
  await rejects(() => store.save({ model: {} }), /Invalid recovery/); assert((await store.load()).model.meta.name === model.meta.name, "invalid save replaced recovery");
  const mutable = structuredClone(saved); mutable.model.meta.name = "Captured edit";
  const captured = store.save(mutable); mutable.model.meta.name = "Later mutation"; await captured;
  assert((await store.load()).model.meta.name === "Captured edit", "save did not capture immediately");
  // Throw the same DOMException a browser emits on quota exhaustion.
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(...args) { if (this.name === "assets") throw new DOMException("Storage quota exhausted", "QuotaExceededError"); return put.apply(this, args); };
  try { await rejects(() => store.save(saved), /quota/); } finally { IDBObjectStore.prototype.put = put; }
  assert((await store.load()).model.meta.name === "Captured edit", "quota failure destroyed previous save");
  IDBObjectStore.prototype.put = function(...args) {
    if (this.name === "revisions" && String(args[1]).startsWith("backup:")) throw new DOMException("Revision quota exhausted", "QuotaExceededError");
    return put.apply(this, args);
  };
  try { await rejects(() => store.save(saved), /quota/); } finally { IDBObjectStore.prototype.put = put; }
  assert((await store.load()).model.meta.name === "Captured edit", "partial transaction committed current before failure");
  const transact = IDBDatabase.prototype.transaction; let abortNext = true;
  IDBDatabase.prototype.transaction = function(...args) { const tx = transact.apply(this, args); if (abortNext && args[1] === "readwrite") { abortNext = false; queueMicrotask(() => tx.abort()); } return tx; };
  try { await rejects(() => store.save(saved), /abort/); } finally { IDBDatabase.prototype.transaction = transact; }
  assert((await store.load()).model.meta.name === "Captured edit", "aborted save destroyed previous save");
  const saves = Array.from({ length: 15 }, (_, i) => { const s = structuredClone(saved); s.model.meta.name = "Rapid " + i; return store.save(s); });
  await Promise.all(saves); assert((await store.load()).model.meta.name === "Rapid 14", "queued save order");
  const counts = await new Promise(resolve => { const tx = db.transaction(["assets", "revisions"]); const assets = tx.objectStore("assets").count(), revisions = tx.objectStore("revisions").count(); tx.oncomplete = () => resolve([assets.result, revisions.result]); });
  assert(counts[0] === 1 && counts[1] === 11, "dedup/retention failed: " + counts);
  // Distinct edits exercise actual collection, rather than only dedup counts.
  for (let i = 0; i < 12; i++) {
    const next = structuredClone(saved); art.getContext("2d").fillStyle = `rgb(${i*20},40,90)`; art.getContext("2d").fillRect(0,0,16,16);
    for (const layer of next.model.layers) layer.source.src = art.toDataURL();
    await store.save(next);
  }
  const retained = await store.revisions(); assert(retained.length === 10, "revision retention");
  for (const revision of retained) assert((await store.load(revision)).model.layers.length === 2, "retained artwork deleted");
  const collected = await new Promise(resolve => { const r = db.transaction("assets").objectStore("assets").count(); r.onsuccess = () => resolve(r.result); });
  assert(collected === 10, "orphan artwork not collected: " + collected);
  const concurrentSave = store.save(saved), concurrentLoad = store.load();
  assert((await concurrentLoad).model.layers.length === 2, "concurrent load saw partial artwork"); await concurrentSave;
  const validRevision = (await store.revisions())[0];
  await rejects(() => store.load({ frame: "{" }), /malformed/);
  const missing = JSON.parse(validRevision.frame); missing.model.layers[0].source.src.$asset = "missing";
  await rejects(() => store.load({ frame: JSON.stringify(missing) }), /Missing recovery artwork/);
  const invalid = JSON.parse(validRevision.frame); invalid.model.layers = null;
  await rejects(() => store.load({ frame: JSON.stringify(invalid) }), /Invalid recovery/);
  const hash = JSON.parse(validRevision.frame).model.layers[0].source.src.$asset;
  await transaction(["assets"], tx => tx.objectStore("assets").put("corrupt", hash));
  await rejects(() => store.load(), /Corrupted recovery artwork/);
  await store.save(saved); assert((await store.load()).model.meta.name === model.meta.name, "retry after corruption");
  // A corrupt retained revision cannot cause GC to delete potentially live art.
  await transaction(["revisions"], tx => tx.objectStore("revisions").put({ frame: "{", at: Date.now(), name: "Corrupted" }, "backup:zz"));
  await store.save(saved); assert((await store.load()).model.layers.length === 2, "corrupt revision prevented good save");
  await transaction(["assets", "revisions"], tx => { tx.objectStore("assets").clear(); tx.objectStore("revisions").clear(); });
  localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(saved));
  IDBObjectStore.prototype.put = function(...args) { if (this.name === "assets") throw new DOMException("Migration quota exhausted", "QuotaExceededError"); return put.apply(this,args); };
  try {
    const legacy = await store.load(); assert(legacy.model.meta.name === model.meta.name && legacy.recoveryWarning.includes("quota"), "failed migration discarded legacy work");
    assert(localStorage.getItem(AUTOSAVE_KEY) === JSON.stringify(saved), "failed migration deleted legacy work");
  } finally { IDBObjectStore.prototype.put = put; }
  assert((await store.load()).model.meta.name === model.meta.name, "legacy migration");
  localStorage.removeItem(AUTOSAVE_KEY); assert((await store.load()).model.layers.length === 2, "migration not persisted");
  await transaction(["assets", "revisions"], tx => { tx.objectStore("assets").clear(); tx.objectStore("revisions").clear(); });
  localStorage.setItem(AUTOSAVE_KEY, '{"model":{}}'); await rejects(() => store.load(), /Invalid recovery/);
  localStorage.removeItem(AUTOSAVE_KEY); await store.save(saved);
  db.close();
  return { storage: "quota/abort/retry/order/dedup/retention/corruption/migration", renderer: "30 switches, invalid import, real context recovery", recordingBytes: recording.size, restartName: model.meta.name };
}
