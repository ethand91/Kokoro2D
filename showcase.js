const demo = document.querySelector('#character-demo');
const buttons = [...document.querySelectorAll('[data-mode]')];
const messages = { idle: 'Move your cursor around her stage. She’s paying attention.', blink: 'Blink preview: the lids close while the pupils keep their shape.', talk: 'Silent speech preview. Try microphone or timed audio in the Viewer.', happy: 'A little joy, blended into the same rig.', mesh: 'The actual deformed mesh, drawn over the live character.' };
buttons.forEach(button => {
  button.disabled = true;
  button.addEventListener('click', () => {
    buttons.forEach(other => { other.classList.toggle('active', other === button); other.setAttribute('aria-pressed', String(other === button)); });
    document.querySelector('#demo-hint').textContent = messages[button.dataset.mode];
    demo.contentWindow.postMessage({ type: 'kokoro-preview', mode: button.dataset.mode }, location.origin);
  });
});
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== demo.contentWindow) return;
  if (event.data?.type === 'kokoro-ready') {
    document.querySelector('#demo-state').textContent = 'LIVE';
    buttons.forEach(button => { button.disabled = false; });
  } else if (event.data?.type === 'kokoro-unavailable') {
    document.querySelector('#demo-state').textContent = 'STILL ART';
    document.querySelector('#demo-hint').textContent = 'Live preview needs WebGL2. You can still explore the features below.';
  }
});
const toggle = document.querySelector('.install-toggle'), panel = document.querySelector('#install-panel');
toggle.addEventListener('click', () => { panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden)); toggle.querySelector('span').textContent = panel.hidden ? '+' : '−'; });
const copy = document.querySelector('#copy-install');
copy.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(panel.querySelector('code').textContent); copy.textContent = 'Copied ✓'; setTimeout(() => { copy.textContent = 'Copy commands'; }, 2500); }
  catch { const selection = window.getSelection(), range = document.createRange(); range.selectNodeContents(panel.querySelector('code')); selection.removeAllRanges(); selection.addRange(range); copy.textContent = 'Commands selected — copy with your keyboard'; }
});
