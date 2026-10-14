import { KokoroRenderer } from './src/renderer.js';
import { createLayeredSampleModel } from './src/sample.js';
import { PuppetMotion } from './src/motion.js';
import { evaluateScene } from './src/scene.js';
const canvas = document.querySelector('#avatar'), overlay = document.querySelector('#mesh'), ctx = overlay.getContext('2d');
let renderer, model, frameId, mode = 'idle', gaze = null, gazeAt = 0, started = 0, visible = true;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const motion = new PuppetMotion({ style: 'energetic' });
const notify = type => parent.postMessage({ type }, location.origin);
function fallback() { cancelAnimationFrame(frameId); renderer?.dispose(); canvas.hidden = true; overlay.hidden = true; document.querySelector('#fallback').style.display = 'block'; notify('kokoro-unavailable'); }
function fit() { renderer.camera.zoom = Math.min(canvas.clientWidth / 680, canvas.clientHeight / 620) * .94; renderer.camera.y = -105; }
function frame(time) {
  if (!visible) return;
  const seconds = (time - started) / 1000;
  if (gaze && time - gazeAt > 2000) gaze = null;
  const mouth = mode === 'talk' ? { open: Math.max(0, Math.sin(seconds * 9)) * .7, round: .5 + .5 * Math.sin(seconds * 6), form: Math.sin(seconds * 4) * .65 } : null;
  const pose = { ...motion.update(time, model, { active: !reduced.matches || mode !== 'idle', gaze, mouth }) };
  if (mode === 'blink') pose['eyes.blink'] = Math.max(0, Math.sin(seconds * 4)) ** 2;
  if (mode === 'happy') { pose['expr.happy'] = 1; pose['mouth.smile'] = .8; }
  try {
    renderer.render(pose);
    if (overlay.width !== canvas.width || overlay.height !== canvas.height) { overlay.width = canvas.width; overlay.height = canvas.height; }
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (mode === 'mesh') {
      ctx.strokeStyle = '#fae5a499'; ctx.lineWidth = .7 * (canvas.width / canvas.clientWidth);
      const ratio = canvas.width / canvas.clientWidth;
      const scene = evaluateScene(model, pose);
      for (const layer of model.layers.filter(layer => layer.visible && !layer.maskOnly)) {
        const vertices = scene.get(layer.id).vertices;
        const point = vertex => { const p = renderer.worldToScreen(vertices[vertex*2], vertices[vertex*2+1]); return [p.x*ratio, p.y*ratio]; };
        ctx.beginPath();
        for (let i = 0; i < layer.mesh.indices.length; i += 3) { const [a,b,c] = layer.mesh.indices.slice(i,i+3).map(point); ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...c); ctx.closePath(); }
        ctx.stroke();
      }
    }
  } catch (error) { console.error('Character preview failed:', error); fallback(); return; }
  frameId = requestAnimationFrame(frame);
}
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== parent || event.data?.type !== 'kokoro-preview') return;
  if (['idle','blink','talk','happy','mesh'].includes(event.data.mode)) { mode = event.data.mode; started = performance.now(); }
});
canvas.addEventListener('pointermove', event => { const r = canvas.getBoundingClientRect(); gaze = { x: Math.max(-1,Math.min(1,(event.clientX-r.left-r.width/2)/(r.width/2))), y: Math.max(-1,Math.min(1,(event.clientY-r.top-r.height/2)/(r.height/2))) }; gazeAt = performance.now(); });
canvas.addEventListener('pointerleave', () => { gaze = null; });
window.addEventListener('resize', () => { if (renderer) fit(); });
document.addEventListener('visibilitychange', () => { visible = !document.hidden; if (visible && model && renderer?.available) { motion.reset(); frameId = requestAnimationFrame(frame); } else cancelAnimationFrame(frameId); });
window.addEventListener('pagehide', () => { cancelAnimationFrame(frameId); renderer?.dispose(); });
try {
  renderer = new KokoroRenderer(canvas); model = await createLayeredSampleModel(); await renderer.setModel(model); fit();
  renderer.addEventListener('contextlost', () => cancelAnimationFrame(frameId));
  renderer.addEventListener('contextrestored', () => { motion.reset(); frameId = requestAnimationFrame(frame); });
  renderer.addEventListener('recoveryerror', fallback);
  window.previewDiagnostics = () => ({ mode, ...renderer.diagnostics() });
  started = performance.now(); notify('kokoro-ready'); frameId = requestAnimationFrame(frame);
} catch (error) { console.error('Unable to initialize character preview:', error); fallback(); }
