"""2026 workflows and GPU pixels. KOKORO_TEST_URL may select a separate server."""
import asyncio
import base64
import io
import json
import os
from pathlib import Path
import wave
import zipfile
from playwright.async_api import async_playwright

BASE = os.environ.get('KOKORO_TEST_URL', 'http://127.0.0.1:5173')

async def main():
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={'width': 1440, 'height': 1100}, accept_downloads=True)
        page.on('dialog', lambda dialog: dialog.accept())
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(BASE + '/', wait_until='networkidle')
        await page.wait_for_selector('#layerList .layer-row')
        print('Maker:', await page.locator('#statusText').inner_text(), flush=True)
        stored = await page.evaluate("""async()=>{const {projectStore}=await import('/src/project-store.js');try{await projectStore.queue;const saved=await projectStore.load();return {name:saved?.model?.meta?.name,count:(await projectStore.revisions()).length};}catch(error){return {error:error.stack};}}""")
        print('Storage:', stored, flush=True)
        assert stored.get('name') == 'Kokoro-chan', stored
        # ZIP export reopens through the Maker and Viewer.
        async with page.expect_download() as download_info:
            await page.click('#exportArchive')
        project = Path(await (await download_info.value).path()).read_bytes()
        with zipfile.ZipFile(io.BytesIO(project)) as z:
            manifest = json.loads(z.read('manifest.json'))
            assert manifest['version'] == 1
            assert all(layer['source']['src'].startswith('assets/') for layer in manifest['model']['layers'])
        await page.locator('#modelFile').set_input_files({'name':'roundtrip.kokoro2d.zip','mimeType':'application/zip','buffer':project})
        await page.wait_for_function("document.querySelector('#statusText').textContent==='Kokoro2D model imported'")
        # A saved revision restores a real edit, including its selected artwork.
        await page.locator('#modelName').fill('Recovery edit')
        await page.locator('#modelName').dispatch_event('change')
        await page.evaluate("import('/src/project-store.js').then(m=>m.projectStore.queue)")
        await page.click('#recoverProject')
        await page.locator('.recovery-dialog button').filter(has_text='Kokoro-chan').first.click()
        await page.wait_for_function("document.querySelector('#modelName').value==='Kokoro-chan'")
        await page.click('#createGroup')
        await page.locator('#groupOpacity').fill('0.5')
        await page.locator('#groupOpacity').dispatch_event('change')
        assert await page.locator('#groupOpacity').input_value() == '0.5'
        await page.click('#undo')
        await page.wait_for_function("document.querySelector('#groupOpacity').value==='1'")
        await page.click('#dissolveGroup')
        # Isolated artwork editing cancels without mutating the project.
        await page.click('#editArtwork')
        await page.wait_for_selector('.art-dialog[open]')
        await page.click('.art-cancel')
        await page.wait_for_selector('.art-dialog', state='detached')
        await page.goto(BASE + '/viewer.html', wait_until='networkidle')
        await page.wait_for_selector('input[data-parameter="eyes.blinkLeft"]')
        assert 'from the Maker' in await page.locator('#viewerStatus').inner_text(), await page.locator('#viewerStatus').inner_text()
        await page.locator('#viewerFile').set_input_files({'name':'roundtrip.zip','mimeType':'application/zip','buffer':project})
        await page.wait_for_function("document.querySelector('#viewerStatus').textContent.includes('from file')")
        # API commands clamp values and expire back to procedural performance.
        await page.get_by_text('Streaming and framing',exact=True).click()
        await page.locator('#listenLocalControls').check()
        response = await page.request.post(BASE+'/api/control',data={'type':'parameters','values':{'head.yaw':99,'eyes.blinkLeft':1},'holdMs':800})
        assert response.ok
        await page.wait_for_function("Number(document.querySelector('input[data-parameter=\"head.yaw\"]').value)===1")
        await page.wait_for_timeout(1100)
        assert float(await page.locator('input[data-parameter="head.yaw"]').input_value()) < 1
        await page.locator('#listenLocalControls').uncheck()
        # Expression keyboard controls ignore text entry.
        await page.locator('body').click(position={'x':20,'y':100})
        await page.keyboard.press('1')
        assert await page.locator('.expression.active').count() == 1
        await page.keyboard.press('0')
        assert await page.locator('.expression.active').count() == 0
        # A real audio element owns viseme time; paused audio releases the mouth.
        buffer=io.BytesIO()
        with wave.open(buffer,'wb') as wav:
            wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(8000);wav.writeframes(b'\0\0'*16000)
        await page.locator('#timedAudioFile').set_input_files({'name':'silence.wav','mimeType':'audio/wav','buffer':buffer.getvalue()})
        track={'segments':[{'viseme':'aa','t0':0,'t1':700},{'viseme':'PP','t0':700,'t1':1400},{'viseme':'U','t0':1400,'t1':2000}]}
        await page.locator('#timedVisemeFile').set_input_files({'name':'track.json','mimeType':'application/json','buffer':json.dumps(track).encode()})
        await page.wait_for_function("document.querySelector('#timedAudio').readyState>=2")
        await page.evaluate("document.querySelector('#timedAudio').play()")
        await page.wait_for_timeout(250)
        assert float(await page.locator('input[data-parameter="mouth.open"]').input_value()) > .5
        await page.evaluate("document.querySelector('#timedAudio').currentTime=.8")
        await page.wait_for_timeout(180)
        assert float(await page.locator('input[data-parameter="mouth.open"]').input_value()) < .1
        await page.evaluate("document.querySelector('#timedAudio').pause()")
        await page.goto(BASE+'/viewer.html?stream=1&zoom=.65&x=20&y=-30',wait_until='domcontentloaded')
        await page.wait_for_selector('input[data-parameter="eyes.blink"]',state='attached')
        assert await page.locator('.topbar').is_hidden()
        assert await page.locator('.viewer-sidebar').is_hidden()
        assert await page.evaluate("getComputedStyle(document.querySelector('.viewer-stage-wrap')).backgroundColor") == 'rgba(0, 0, 0, 0)'
        await page.screenshot(path='/private/tmp/kokoro2d-stream.png',omit_background=True)
        await page.goto(BASE+'/static/',wait_until='networkidle')
        gpu = await page.evaluate("""async()=>{
          const {KokoroRenderer}=await import('/src/renderer.js');
          const {createModel,createLayer}=await import('/src/model.js');
          document.body.replaceChildren();const canvas=document.createElement('canvas');canvas.style.cssText='width:128px;height:128px';document.body.append(canvas);
          const r=new KokoroRenderer(canvas);r.camera.zoom=1;
          const layer=(name,color,width=80,x=0)=>createLayer({name,src:'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><path fill="${color}" d="M0 0h8v8H0Z"/></svg>`),width,height:80,x});
          const read=(x=64,y=64)=>{const pixel=new Uint8Array(4);r.gl.readPixels(x,y,1,1,r.gl.RGBA,r.gl.UNSIGNED_BYTE,pixel);return [...pixel];};
          const render=async(m)=>{await r.setModel(m);r.render({});if(r.gl.getError())throw Error('WebGL error');return read();};
          const report={};
          for(const mode of ['multiply','screen','overlay']){const m=createModel();const b=layer('base','#808080'),s=layer('top','#ff8000');s.zIndex=1;s.blendMode=mode;m.layers=[b,s];report[mode]=await render(m);}
          const m=createModel(),a=layer('red','#ff0000'),b=layer('blue','#0000ff');b.zIndex=1;a.group=b.group='group';m.groups=[{id:'group',opacity:.5}];m.layers=[a,b];report.group=await render(m);
          m.groups.push({id:'outer',opacity:.5});m.groups[0].parent='outer';report.nestedGroup=await render(m);
          const maskA=layer('maskA','#fff',80,-20),maskB=layer('maskB','#fff',80,20),paint=layer('paint','#00ff00',120);
          maskA.maskOnly=maskB.maskOnly=true;maskB.clipMask=maskA.id;paint.clipMask=maskB.id;
          const masked=createModel();masked.layers=[maskA,maskB,paint];report.maskInside=await render(masked);report.maskOutside=read(95,64);
          paint.clipMask=null;paint.group='clipped';masked.groups=[{id:'clipped',opacity:.5,clipMask:maskB.id}];report.groupMaskInside=await render(masked);report.groupMaskOutside=read(95,64);
          const empty=createModel();const half=layer('half','#cc8040');half.transform.opacity=.5;half.blendMode='multiply';empty.layers=[half];report.transparentBlend=await render(empty);
          r.render({});report.stationaryUploads=r.metrics.uploads;report.error=r.gl.getError();return report;
        }""")
        print('GPU pixels:', gpu, flush=True)
        def near(actual, expected):
            assert all(abs(a-b)<=2 for a,b in zip(actual,expected)), (actual,expected)
        near(gpu['multiply'],[128,64,0,255]);near(gpu['screen'],[255,192,128,255]);near(gpu['overlay'],[255,128,1,255])
        near(gpu['group'],[0,0,255,128]);near(gpu['nestedGroup'],[0,0,255,64])
        near(gpu['maskInside'],[0,255,0,255]);assert gpu['maskOutside'][3]==0
        near(gpu['groupMaskInside'],[0,255,0,128]);assert gpu['groupMaskOutside'][3]==0
        near(gpu['transparentBlend'],[204,128,64,128]);assert gpu['stationaryUploads']==0;assert gpu['error']==0
        # Real DEFLATE archive, including offsets/groups, from a normal ZIP tool.
        png = await page.evaluate("""()=>{const c=document.createElement('canvas');c.width=8;c.height=6;const x=c.getContext('2d');x.fillStyle='red';x.fillRect(0,0,8,6);return c.toDataURL().split(',')[1];}""")
        archive=io.BytesIO()
        with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
            z.writestr('mimetype','image/openraster');z.writestr('data/layer.png',base64.b64decode(png));z.writestr('stack.xml','<image w="100" h="80"><stack><stack name="Shadows" opacity="0.5" composite-op="svg:multiply"><layer name="Face" src="data/layer.png" x="12" y="9"/></stack></stack></image>')
        ora = await page.evaluate("""async(bytes)=>{const {importOpenRaster}=await import('/src/openraster.js');const m=await importOpenRaster(new File([new Uint8Array(bytes)],'test.ora'));return {x:m.layers[0].transform.x,y:m.layers[0].transform.y,group:m.layers[0].group,g:m.groups[0]};}""", list(archive.getvalue()))
        assert ora['x']==-34 and ora['y']==-28 and ora['group']==ora['g']['id'] and ora['g']['opacity']==.5 and ora['g']['blendMode']=='multiply',ora
        assert not errors,errors
        await browser.close()
    print('PASS: project/recovery, artist controls, audio, API, streaming, compositing, OpenRaster')

if __name__=='__main__':
    asyncio.run(main())
