"""Local detector + editor integration. Requires Playwright and anime-face-detector.

python3 tests/browser_anime.py [path/to/portrait.png]
Starts its own server on a free localhost port; does not replace npm start.
"""
import asyncio
import base64
import json
from pathlib import Path
import sys
import threading
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from serve import NoStoreHandler
from playwright.async_api import async_playwright


async def main(url, portrait):
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000})
        page.set_default_timeout(130000)
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda dialog: dialog.accept())
        await page.goto(url)
        status = await page.request.get(url + '/api/anime-landmarks')
        assert (await status.json())['available'], 'Install/configure anime-face-detector first.'
        await page.click('#autoRigButton')
        await page.check('#autoRigFaceOnly')
        await page.set_input_files('#autoRigInput', str(portrait))
        await page.wait_for_selector('.build-rig')
        assert 'Anime landmarks applied' in await page.locator('.anime-status').inner_text()
        assert await page.locator('.build-rig').is_enabled()
        await page.select_option('.region-select', 'mouth')
        if portrait.name == 'Lunari.png':
            assert await page.locator('.mouth-closed').is_checked()
        await page.click('.region-numeric summary')
        original = await page.locator('[aria-label="Region x"]').input_value()
        await page.locator('[aria-label="Region x"]').fill(str(float(original) + 2))
        await page.locator('[aria-label="Region x"]').blur()
        await page.click('.region-undo')
        assert await page.locator('[aria-label="Region x"]').input_value() == original
        await page.click('.build-rig')
        await page.wait_for_selector('#autoRigReport:not([hidden])')
        assert 'Anime landmarks' in await page.locator('#autoRigResultStats').inner_text()
        await page.click('#autoRigClose')
        async with page.expect_download() as download:
            await page.click('#exportModel')
        model = json.loads(Path(await (await download.value).path()).read_text())
        assert model['meta']['autoRig']['faceOnly']
        assert len(model['meta']['regions']['leftEye']['contour']) == 6
        if portrait.name == 'Lunari.png':
            eye = model['meta']['regions']['leftEye']
            assert 460 < eye['x'] < 480 and 560 < eye['y'] < 585, eye
            assert model['meta']['regions']['mouth']['sourceClosed']
        # Save actual WebGL mouth poses for visual review, using the exported rig.
        strip = await page.evaluate("""async model => {
          const {KokoroRenderer}=await import('/src/renderer.js');
          const {defaultParameterValues}=await import('/src/model.js');
          const mouth=model.layers.find(l=>l.name.startsWith('Mouth • open'));
          const canvas=document.createElement('canvas');
          canvas.style.cssText='width:240px;height:180px';document.body.append(canvas);
          const renderer=new KokoroRenderer(canvas);await renderer.setModel(model);
          Object.assign(renderer.camera,{x:mouth.transform.x,y:mouth.transform.y,zoom:3});
          const strip=Object.assign(document.createElement('canvas'),{width:960,height:210});
          const ctx=strip.getContext('2d');ctx.fillStyle='#24172f';ctx.fillRect(0,0,960,210);
          const poses=[['Rest',0,0,0],['Quiet',.3,0,0],['Wide',.8,1,0],['Rounded',.8,0,1]];
          poses.forEach(([label,open,form,round],i)=>{
            renderer.render({...defaultParameterValues(model),'mouth.open':open,'mouth.form':form,'mouth.round':round});
            ctx.drawImage(canvas,i*240,0,240,180);ctx.fillStyle='white';ctx.font='16px sans-serif';ctx.fillText(label,i*240+12,200);
          });
          canvas.remove();return strip.toDataURL('image/png').split(',')[1];
        }""", model)
        Path('/private/tmp/kokoro-anime-mouths.png').write_bytes(base64.b64decode(strip))
        # Full rigs consume the same learned contours, including the jaw outline.
        await page.click('#autoRigButton')
        await page.uncheck('#autoRigFaceOnly')
        await page.set_input_files('#autoRigInput', str(portrait))
        await page.wait_for_selector('.build-rig')
        assert 'Anime landmarks applied' in await page.locator('.anime-status').inner_text()
        await page.screenshot(path='/private/tmp/kokoro-anime-landmarks.png')
        await page.click('.build-rig')
        await page.wait_for_selector('#autoRigReport:not([hidden])')
        await page.click('#autoRigClose')
        async with page.expect_download() as download:
            await page.click('#exportModel')
        full = json.loads(Path(await (await download.value).path()).read_text())
        assert not full['meta']['autoRig']['faceOnly']
        assert full['meta']['autoRig']['landmarkMethod'] == 'Anime landmarks'
        assert len(full['meta']['regions']['face']['contour']) == 7
        root = next(l for l in full['layers'] if l['name'] == 'Portrait Deformer')
        for name in ['Torso', 'Head Deformer']:
            assert next(l for l in full['layers'] if l['name'] == name)['parent']['id'] == root['id']
        assert not any(w.startswith('No neck') for w in full['meta']['autoRig']['warnings'])
        head_strip = await page.evaluate("""async model => {
          const {KokoroRenderer}=await import('/src/renderer.js');
          const {defaultParameterValues}=await import('/src/model.js');
          const c=document.createElement('canvas');c.style.cssText='width:420px;height:540px';document.body.append(c);
          const r=new KokoroRenderer(c);await r.setModel(model);r.camera.zoom=.55;
          const out=Object.assign(document.createElement('canvas'),{width:840,height:570});
          const ctx=out.getContext('2d');ctx.fillStyle='#24172f';ctx.fillRect(0,0,840,570);
          const poses=[{}, {'head.yaw':.8,'head.pitch':.3,'head.roll':.8,'body.sway':.35}];
          poses.forEach((pose,i)=>{r.render({...defaultParameterValues(model),...pose});ctx.drawImage(c,i*420,0,420,540);});
          ctx.fillStyle='white';ctx.font='16px sans-serif';ctx.fillText('Rest',12,558);ctx.fillText('Turn + tilt + body sway',432,558);
          c.remove();return out.toDataURL('image/png').split(',')[1];
        }""", full)
        Path('/private/tmp/kokoro-head-motion.png').write_bytes(base64.b64decode(head_strip))
        # A missing service must leave a working manual review, not fail import.
        await page.route('**/api/anime-landmarks', lambda route: route.fulfill(
            status=503, content_type='application/json', body='{"error":"Detector unavailable in test"}'))
        await page.click('#autoRigButton')
        await page.set_input_files('#autoRigInput', str(portrait))
        await page.wait_for_selector('.build-rig')
        assert 'Detector unavailable in test' in await page.locator('.anime-status').inner_text()
        assert await page.locator('.build-rig').is_enabled()
        await page.click('.detect-anime')
        await page.wait_for_function("!document.querySelector('.region-editor').inert")
        assert 'Detector unavailable in test' in await page.locator('.anime-status').inner_text()
        await page.screenshot(path='/private/tmp/kokoro-anime-fallback.png')
        assert not errors, errors
        await browser.close()
        print({'portrait': portrait.name, 'learned_outlines': 'passed', 'closed_mouth': 'passed', 'undo': 'passed', 'export': 'passed', 'full_rig': 'passed', 'unavailable_fallback': 'passed'})


if __name__ == '__main__':
    portrait = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / 'static/kokoro-chan.webp'
    server = ThreadingHTTPServer(('127.0.0.1', 0), NoStoreHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        asyncio.run(main(f'http://127.0.0.1:{server.server_port}', portrait))
    finally:
        server.shutdown()
        server.server_close()
