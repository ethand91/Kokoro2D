"""Real WebGL recovery and microphone/recording ownership. Run against npm start."""
import asyncio
import os
from playwright.async_api import async_playwright

URL = os.environ.get("KOKORO_TEST_URL", "http://127.0.0.1:5173")

async def lose_and_restore(page, selector, recording=False):
    await page.evaluate("""selector => {
      const canvas = document.querySelector(selector);
      window.loss = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
      if (!window.loss) throw new Error('WEBGL_lose_context is required for this check');
      window.loss.loseContext();
    }""", selector)
    status = '#viewerStatus' if selector == '#viewerCanvas' else '#statusText'
    await page.wait_for_function("selector => document.querySelector(selector).textContent.includes('context lost')", arg=status)
    if recording:
        assert not await page.locator('#recordButton').evaluate("el => el.classList.contains('recording')")
        assert await page.is_disabled('#recordButton')
        assert 'Recording cancelled' in await page.inner_text(status)
    await page.evaluate("window.loss.restoreContext()")
    try:
        await page.wait_for_function("selector => document.querySelector(selector).textContent.includes('Graphics recovered')", arg=status)
    except Exception as error:
        raise AssertionError(f"Recovery failed at {selector}: {await page.inner_text(status)}") from error

async def main():
    async with async_playwright() as p:
        engine = os.environ.get("KOKORO_BROWSER", "chromium")
        browser = await getattr(p, engine).launch(headless=True, **({"args": [
            "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]} if engine == "chromium" else {"firefox_user_prefs": {"media.navigator.streams.fake": True, "media.navigator.permission.disabled": True}}))
        context = await browser.new_context(viewport={"width": 1280, "height": 900}, **({"permissions": ["microphone"]} if engine == "chromium" else {}))
        await context.add_init_script("""(() => {
          window.testStreams = []; window.testAudio = [];
          const media = navigator.mediaDevices, original = media.getUserMedia.bind(media);
          media.getUserMedia = async constraints => {
            const stream = await original(constraints);
            if (constraints.audio) window.testStreams.push(stream);
            return stream;
          };
          const Audio = window.AudioContext;
          window.AudioContext = class extends Audio {
            constructor(...args) { super(...args); window.testAudio.push(this); }
          };
        })();""")
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(URL + '/viewer.html')
        await page.wait_for_function("document.querySelectorAll('#viewerControls input').length > 3")
        assert await page.evaluate('testStreams.length') == 0, 'loading must not request microphone'
        await page.click('#enableMic')
        await page.wait_for_function("document.querySelector('#enableMic').getAttribute('aria-pressed') === 'true'")
        assert await page.evaluate('testStreams.length') == 1
        assert await page.evaluate('testAudio.length') == 1
        # Device selection replaces the session, with old audio closed before new capture.
        options = await page.locator('#micDevice option').evaluate_all("options => options.map(o => o.value).filter(Boolean)")
        if options:
            await page.select_option('#micDevice', options[-1])
            await page.wait_for_function("testStreams.length === 2 && testAudio.length === 2 && testAudio[0].state === 'closed'")
            assert await page.evaluate("testStreams[0].getTracks().every(t => t.readyState === 'ended')")
        await page.click('#recordButton')
        await page.wait_for_timeout(400)
        await lose_and_restore(page, '#viewerCanvas', recording=True)
        assert await page.evaluate("testStreams.at(-1).getTracks().every(t => t.readyState === 'live')")
        assert not await page.is_disabled('#recordButton')
        # Recording is still usable after graphics recovery.
        await page.click('#recordButton')
        await page.wait_for_timeout(500)
        async with page.expect_download() as pending:
            await page.click('#recordButton')
        download = await pending.value
        assert (await download.path()) is not None
        assert await page.evaluate("testStreams.at(-1).getTracks().every(t => t.readyState === 'live')")
        await page.click('#enableMic')
        await page.wait_for_function("testAudio.every(a => a.state === 'closed')")
        assert await page.evaluate("testStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))")
        await page.click('#enableMic')
        await page.wait_for_function("document.querySelector('#enableMic').getAttribute('aria-pressed') === 'true'")
        await page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))")
        await page.wait_for_function("testAudio.every(a => a.state === 'closed')")
        assert await page.evaluate("testStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))")
        await page.goto(URL + '/')
        await page.wait_for_function("document.querySelectorAll('#layerList .layer-row').length > 10")
        await page.wait_for_function("document.querySelector('#statusText').textContent.includes('ready')")
        await lose_and_restore(page, '#makerCanvas')
        print("Viewer and Maker recovery passed; checking deterministic pixels", flush=True)
        # Deterministic pixels survive a real context reset on an isolated renderer.
        result = await page.evaluate("""async () => {
          const { KokoroRenderer } = await import('/src/renderer.js');
          const { createModel, createLayer } = await import('/src/model.js');
          const art = document.createElement('canvas'); art.width = art.height = 16;
          const ctx = art.getContext('2d'); ctx.fillStyle = '#ff55aa'; ctx.fillRect(0, 0, 16, 16);
          const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:128px;height:128px'; document.body.append(canvas);
          const renderer = new KokoroRenderer(canvas), model = createModel('Recovery pixels');
          model.layers.push(createLayer({name:'Paint',src:art.toDataURL(),width:64,height:64}));
          model.version = 1; await renderer.setModel(model);
          model.version = 2; await renderer.setModel(model);
          renderer.camera.zoom = .9;
          const pose = {'head.yaw':.4,'eyes.blink':.5};
          const pixels = () => { renderer.render(pose); const gl=renderer.gl, p=new Uint8Array(canvas.width*canvas.height*4); gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };
          const before = pixels();
          const loss = renderer.gl.getExtension('WEBGL_lose_context');
          let done = new Promise(resolve => renderer.addEventListener('contextlost', resolve, {once:true}));
          loss.loseContext(); await done;
          await new Promise(resolve => setTimeout(resolve, 100));
          done = new Promise(resolve => renderer.addEventListener('contextrestored', resolve, {once:true}));
          loss.restoreContext(); await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('Isolated renderer context restore timed out')), 10000))]);
          const after = pixels();
          const result = {nonempty:before.some(v=>v),same:before.every((v,i)=>v===after[i]),zoom:renderer.camera.zoom,blink:renderer.parameters['eyes.blink'],error:renderer.gl.getError()};
          renderer.dispose(); canvas.remove(); return result;
        }""")
        assert result == {'nonempty': True, 'same': True, 'zoom': .9, 'blink': .5, 'error': 0}, result
        assert errors == [], errors
        await browser.close()
        print('Lifecycle passed: Maker/Viewer recovery, identical pixels, v1/v2, device switch, microphone cleanup, interrupted and resumed recording.')

asyncio.run(asyncio.wait_for(main(), timeout=120))
