"""Production hardening with real IndexedDB/WebGL/media and controlled failures.
KOKORO_BROWSER=chromium|firefox; KOKORO_TEST_URL selects the running local server.
"""
import asyncio
import json
import os
import tempfile
from playwright.async_api import async_playwright

BASE = os.environ.get('KOKORO_TEST_URL', 'http://127.0.0.1:5173')
BROWSER = os.environ.get('KOKORO_BROWSER', 'chromium')

async def main():
    errors = []
    with tempfile.TemporaryDirectory(prefix='kokoro-hardening-') as profile:
        async with async_playwright() as p:
            engine = getattr(p, BROWSER)
            context = await engine.launch_persistent_context(profile, headless=True)
            page = await context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.goto(BASE + '/viewer.html')
            await page.wait_for_selector('input[data-parameter="head.yaw"]')
            control_model = await page.evaluate("""async()=> {
              const {createModel,createLayer}=await import('/src/model.js');const m=createModel('Control ranges');
              m.parameters['expr.test']={id:'expr.test',name:'Limited expression',min:.2,max:.4,default:.2};
              const c=document.createElement('canvas');c.width=c.height=8;c.getContext('2d').fillRect(0,0,8,8);
              m.layers.push(createLayer({name:'Paint',src:c.toDataURL(),width:32,height:32}));return m;
            }""")
            await page.locator('#viewerFile').set_input_files({'name':'controls.kokoro2d','mimeType':'application/json','buffer':json.dumps(control_model).encode()})
            await page.wait_for_function("document.querySelector('#viewerStatus').textContent.includes('from file')")
            # Mock only camera/worker dependencies; drive the actual Viewer UI.
            await page.evaluate("""() => {
              window.cameraTracks = []; window.workers = [];
              navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {
                window.grantCamera = () => { const track = {stops:0,stop(){this.stops++;}}; cameraTracks.push(track); resolve({getTracks:()=>[track]}); };
              });
              const create = document.createElement.bind(document);
              document.createElement = (tag, ...args) => tag === 'video' ? {muted:true,playsInline:true,srcObject:null,videoWidth:0,play:async()=>{},pause(){this.srcObject=null;}} : create(tag,...args);
              window.Worker = class {constructor(){this.ended=false;workers.push(this);} postMessage(){queueMicrotask(()=>this.onmessage?.({data:{type:'ready'}}));} terminate(){this.ended=true;}};
            }""")
            await page.click('#enableTracking')
            assert await page.inner_text('#enableTracking') == 'Cancel webcam request'
            await page.click('#enableTracking')
            await page.evaluate('grantCamera()')
            await page.wait_for_function('cameraTracks[0].stops===1')
            for _ in range(10):
                await page.click('#enableTracking')
                await page.evaluate('grantCamera()')
                await page.wait_for_function("document.querySelector('#enableTracking').textContent==='Stop webcam'")
                await page.click('#enableTracking')
            assert await page.evaluate('cameraTracks.every(t=>t.stops===1)&&workers.every(w=>w.ended)')
            camera_resources = await page.evaluate("({cycles:10,tracksReleased:cameraTracks.length,workersTerminated:workers.filter(w=>w.ended).length})")
            await page.get_by_text('Streaming and framing', exact=True).click()
            await page.locator('#listenLocalControls').check()
            response = await page.request.post(BASE+'/api/control', data={'type':'parameters','values':{'head.yaw':99},'holdMs':1500})
            assert response.ok
            await page.wait_for_function("Number(document.querySelector('input[data-parameter=\"head.yaw\"]').value)===1")
            expression = await page.request.post(BASE+'/api/control', data={'type':'expression','id':'expr.test'})
            assert expression.ok
            await page.wait_for_function("Number(document.querySelector('input[data-parameter=\"expr.test\"]').value)===.4")
            await page.request.post(BASE+'/api/control', data={'type':'expression','id':'expr.unknown'})
            await page.wait_for_function("document.querySelector('#viewerStatus').textContent.includes('Undeclared expression')")
            for payload, headers in [({'type':'parameters','values':{'head.yaw':'bad'}},{}), ({'type':'reset'},{'Origin':'https://attacker.example'}), ({'type':'reset'},{'Host':'attacker.example'})]:
                rejected = await page.request.post(BASE+'/api/control', data=payload, headers=headers)
                assert rejected.status in (400,403), rejected.status
            await page.locator('#listenLocalControls').uncheck()
            await page.goto(BASE+'/viewer.html')  # Clear patched media before actual recording.
            await page.wait_for_selector('input[data-parameter="head.yaw"]')
            result = await page.evaluate("async()=> (await import('/tests/browser_hardening.js')).runHardeningChecks()")
            assert not errors, errors
            await page.add_init_script("""(() => {
              const original = IDBDatabase.prototype.transaction; let fail = true;
              IDBDatabase.prototype.transaction = function(...args) {
                if (fail && args[1] === 'readonly') { fail=false; throw new DOMException('Interrupted startup read','AbortError'); }
                return original.apply(this,args);
              };
            })();""")
            await page.goto(BASE+'/')
            await page.wait_for_function("document.querySelector('#statusText').textContent.includes('stored work kept')")
            preserved = await page.evaluate("""async()=> {
              const db=await new Promise(resolve=>{const r=indexedDB.open('kokoro2d-projects',1);r.onsuccess=()=>resolve(r.result);});
              const name=await new Promise(resolve=>{const r=db.transaction('revisions').objectStore('revisions').get('current');r.onsuccess=()=>resolve(JSON.parse(r.result.frame).model.meta.name);});
              db.close();return name;
            }""")
            assert preserved == result['restartName'], preserved
            await page.goto(BASE+'/viewer.html')
            await page.wait_for_function("document.querySelector('#viewerStatus').textContent.includes('Stored work kept')")
            failed_save = await context.new_page()
            await failed_save.add_init_script("""(() => {
              const put=IDBObjectStore.prototype.put;
              IDBObjectStore.prototype.put=function(...args){if(this.name==='assets')throw new DOMException('Startup quota exhausted','QuotaExceededError');return put.apply(this,args);};
            })();""")
            await failed_save.goto(BASE+'/')
            await failed_save.wait_for_function("document.querySelector('#statusText').textContent.includes('Autosave failed')")
            assert await failed_save.locator('#modelName').input_value() == result['restartName']
            await context.close()
            # Reopen a browser process using the same profile, not just a page reload.
            context = await engine.launch_persistent_context(profile, headless=True)
            page = await context.new_page()
            await page.goto(BASE+'/viewer.html')
            recovered = await page.evaluate("async()=> (await (await import('/src/project-store.js')).projectStore.load()).model.meta.name")
            assert recovered == result['restartName'], recovered
            await context.close()
            print(json.dumps({'browser':BROWSER,'result':result,'browserRestart':'passed','cameraResources':camera_resources}), flush=True)

if __name__ == '__main__':
    asyncio.run(asyncio.wait_for(main(), timeout=180))
