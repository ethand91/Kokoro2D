"""Run against npm start: python3 tests/browser_rig.py (requires Playwright)."""
import os
import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright

async def main():
    errors=[]
    detection={}
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        page=await browser.new_page(viewport={"width":1440,"height":1000},accept_downloads=True)
        page.on('pageerror',lambda e:errors.append(str(e)))
        await page.goto(os.environ.get("KOKORO_TEST_URL", "http://127.0.0.1:5173") + '/',wait_until='networkidle')
        await page.wait_for_function("document.querySelectorAll('#layerList .layer-row').length > 10")
        count=await page.locator('#layerList .layer-row').count()
        async with page.expect_download() as info:
            await page.click('#exportModel')
        download=await info.value
        exported=json.loads(Path(await download.path()).read_text())
        assert exported['version']==3
        assert all(l['source']['src'].startswith('data:') for l in exported['layers'])
        assert len([l for l in exported['layers'] if l.get('clipMask')])==4  # two irises, two star overlays
        expr={p for p in exported['parameters'] if p.startswith('expr.')}
        assert expr=={'expr.happy','expr.sad','expr.angry','expr.confused'},expr
        stars=[l for l in exported['layers'] if 'Stars' in l['name']]
        assert len(stars)==2,[l['name'] for l in exported['layers']]
        for star in stars:
            assert star['transform']['opacity']==0  # invisible until she is happy
            assert star['keyforms']['expr.happy'][0]['transform']['opacity']==1
            mask=next(l for l in exported['layers'] if l['id']==star['clipMask'])
            assert 'Eye Opening' in mask['name'],mask['name']  # so a blink hides them
        # Every expression must actually deform something beyond the stars.
        for channel in expr:
            movers=[l['name'] for l in exported['layers'] if channel in l.get('keyforms',{})]
            assert len(movers)>=4,(channel,movers)
        # Every layer should be about as big as its own artwork. A full-canvas
        # layer holding a face is ~3% opaque and spends its mesh on empty space.
        fill_js="""async (layers) => {
          const out = [];
          for (const layer of layers) {
            const img = await new Promise((res, rej) => { const i = new Image();
              i.onload = () => res(i); i.onerror = rej; i.src = layer.src; });
            const c = document.createElement('canvas');
            c.width = img.width; c.height = img.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            let opaque = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 24) opaque += 1;
            out.push({ name: layer.name, w: img.width, h: img.height,
                       fill: opaque / (c.width * c.height), verts: layer.verts });
          }
          return out;
        }"""
        # Seam backing intentionally holds sparse original pixels around cuts;
        # its job is to fill holes, rather than be a connected moving art part.
        painted=[l for l in exported['layers'] if not l.get('maskOnly') and l['name']!='Portrait Seam Backing']
        fills=await page.evaluate(fill_js,[{'name':l['name'],'src':l['source']['src'],
                                            'verts':len(l['mesh']['vertices'])//2} for l in painted])
        for f in fills:
            # A full-canvas face is 4% opaque and a full-canvas hair layer 7%;
            # a sparkle overlay is legitimately sparse at ~19%.
            assert f['fill']>0.15,(f['name'],round(f['fill'],3),f['w'],f['h'])
            density=f['verts']/(f['w']*f['h']/1e6)
            assert density>400,(f['name'],round(density))   # verts per megapixel
        # Separated layers should be whole, not confetti. Stray islands are
        # misclassified pixels, and each one is carried by that layer's springs.
        pieces_js="""async (layers) => {
          const out = [];
          for (const layer of layers) {
            const img = await new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=no;i.src=layer.src;});
            const c = document.createElement('canvas');
            c.width = img.width; c.height = img.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const d = ctx.getImageData(0,0,c.width,c.height).data;
            const W = c.width, H = c.height, seen = new Uint8Array(W*H), queue = new Int32Array(W*H);
            const sizes = [];
            for (let s = 0; s < W*H; s++) {
              if (seen[s] || d[s*4+3] <= 24) continue;
              let head = 0, tail = 0; queue[tail++] = s; seen[s] = 1; let n = 0;
              while (head < tail) {
                const i = queue[head++]; n++; const x = i % W;
                for (const j of [i-1,i+1,i-W,i+W]) {
                  if (j < 0 || j >= W*H || seen[j] || d[j*4+3] <= 24) continue;
                  if (Math.abs(j % W - x) > 1) continue;
                  seen[j] = 1; queue[tail++] = j;
                }
              }
              sizes.push(n);
            }
            const total = sizes.reduce((a,b)=>a+b,0);
            out.push({ name: layer.name, share: total ? Math.max(...sizes)/total : 1 });
          }
          return out;
        }"""
        wholeness=await page.evaluate(pieces_js,[{'name':l['name'],'src':l['source']['src']}
                                                 for l in painted if 'Eye' not in l['name']])
        for w in wholeness:
            assert w['share']>0.9,(w['name'],round(w['share'],3))

        # Separated layers must carry a feathered silhouette, or they stamp onto
        # what is beneath them and every cut traces a visible contour. The same
        # buildLayeredRig produces the bundled sample and every auto-rigged PNG,
        # so this covers both paths at once.
        rim_js="""async (layers) => {
          const out = [];
          for (const layer of layers) {
            const img = await new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=no;i.src=layer.src;});
            const c = document.createElement('canvas');
            c.width = img.width; c.height = img.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const d = ctx.getImageData(0,0,c.width,c.height).data;
            let solid = 0, soft = 0;
            for (let i = 3; i < d.length; i += 4) {
              if (d[i] > 235) solid++; else if (d[i] > 24) soft++;
            }
            out.push({ name: layer.name, rim: soft / Math.max(1, solid) });
          }
          return out;
        }"""
        moving=[l for l in painted if l['name'] in ('Face','Bangs')
                or l['name'].endswith('Hair')]
        rims=await page.evaluate(rim_js,[{'name':l['name'],'src':l['source']['src']} for l in moving])
        for r in rims:
            assert r['rim']>0.02,(r['name'],round(r['rim'],4))

        face=next(f for f in fills if f['name']=='Face')
        assert face['w']*face['h'] < 768*1152*0.15,(face['w'],face['h'])

        chest=[p for p in exported['physics'] if p['output'].startswith('chest.')]
        assert len(chest)==2,chest
        assert all(p['damping']<.5 for p in chest),chest  # underdamped, or it will not jiggle
        torso=next(layer for layer in exported['layers'] if layer['name']=='Torso')
        assert {'chest.bounce','chest.sway'}<=set(torso['keyforms']),list(torso['keyforms'])
        # The lobe is local: the chest keyform must not move every torso vertex.
        moved=[i for i,o in enumerate(torso['keyforms']['chest.bounce'][0]['offsets']) if abs(o)>1e-6]
        assert 0<len(moved)<len(torso['keyforms']['chest.bounce'][0]['offsets'])*.8,len(moved)
        await page.goto(os.environ.get("KOKORO_TEST_URL", "http://127.0.0.1:5173") + '/viewer.html',wait_until='networkidle')
        await page.wait_for_selector('input[data-parameter="mouth.round"]')
        # The Viewer opens on whatever the Maker has, not on the bundled sample:
        # the puppet you just rigged was otherwise the one thing you could not
        # look at. The escape hatch back to the sample must be offered with it.
        assert 'from the Maker' in await page.locator('#viewerStatus').inner_text()
        assert await page.locator('#loadSample').is_visible()
        await page.click('#loadSample')
        await page.wait_for_function("document.querySelector('#viewerStatus').textContent.includes('bundled sample')", timeout=30000)
        assert 'bundled sample' in await page.locator('#viewerStatus').inner_text()
        assert not await page.locator('#loadSample').is_visible()
        await page.locator('#demoMode').uncheck()
        async def pose(values):
            for name,value in values.items():
                await page.locator(f'input[data-parameter="{name}"]').evaluate('(el,v)=>{el.value=v;el.dispatchEvent(new Event("input",{bubbles:true}));}',str(value))
            await page.wait_for_timeout(100)
        await pose({k:v['default'] for k,v in exported['parameters'].items()})
        await page.screenshot(path='/private/tmp/kokoro2d-layered-neutral.png')
        await pose({'eyes.blink':.5,'eyes.lookX':1,'head.yaw':.8,'head.roll':.4,'mouth.open':.7,'mouth.round':1})
        await page.screenshot(path='/private/tmp/kokoro2d-layered-half.png')
        await pose({'eyes.blink':1,'mouth.round':0,'mouth.form':1})
        await page.screenshot(path='/private/tmp/kokoro2d-layered-closed.png')
        # Verify actual stencil pixels, including an invisible mask layer.
        clipping=await page.evaluate("""async()=>{
          const {KokoroRenderer}=await import('./src/renderer.js');
          const {createModel,createLayer,ensureKeyform}=await import('./src/model.js');
          const c=document.createElement('canvas'); c.style.cssText='width:100px;height:100px';document.body.append(c);
          const r=new KokoroRenderer(c);r.camera.zoom=1;
          const svg=body=>'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">'+body+'</svg>');
          const model=createModel();
          const mask=createLayer({name:'mask',width:40,height:40,src:svg('<circle cx="20" cy="20" r="20" fill="white"/>')});mask.maskOnly=true;
          const pupil=createLayer({name:'pupil',width:80,height:80,src:svg('<path d="M0 0h40v40H0z" fill="red"/>')});pupil.clipMask=mask.id;
          model.layers=[mask,pupil];ensureKeyform(mask,'eyes.blink',1).transform.scaleY=-1;
          await r.setModel(model);r.render({});
          const pixel=(x,y)=>{const out=new Uint8Array(4);r.gl.readPixels(x,y,1,1,r.gl.RGBA,r.gl.UNSIGNED_BYTE,out);return [...out];};
          const center=pixel(50,50),outside=pixel(15,50);
          r.render({'eyes.blink':1});const closed=pixel(50,50);r.disposeResources();c.remove();return {center,outside,closed};
        }""")
        assert clipping['center']==[255,0,0,255],clipping
        assert clipping['outside'][3]==clipping['closed'][3]==0,clipping
        # Import the exported hierarchy and masks.
        await page.locator('#viewerFile').set_input_files({'name':'roundtrip.kokoro2d','mimeType':'application/json','buffer':json.dumps(exported).encode()})
        await page.wait_for_function("document.querySelector('#viewerStatus').textContent.includes('from file')", timeout=30000)
        assert await page.locator('#puppetTitle').inner_text()=='Kokoro-chan'
        # Pointer-driven eyes retain a target between pointer events.
        await page.locator('#demoMode').check()
        await page.locator('#viewerCanvas').hover(position={'x':850,'y':350})
        await page.wait_for_timeout(400)
        # The eye alone no longer holds the target: the head takes a share and the
        # eye counter-rotates, so the direction to check is the combined one.
        combined_js="""async () => {
          const { STYLES } = await import('./src/motion.js');
          const read = (id) => Number(document.querySelector(`input[data-parameter="${id}"]`).value);
          const style = STYLES[document.querySelector('#motionStyle').value] ?? STYLES.calm;
          return read('eyes.lookX') + read('head.yaw') * style.vorGain;
        }"""
        gaze=await page.evaluate(combined_js)
        assert gaze>.3,gaze
        # A pointer left sitting still is released, and she looks around again.
        moved=0.0
        for _ in range(10):
            await page.wait_for_timeout(500)
            moved=max(moved,abs(await page.evaluate(combined_js)-gaze))
        assert moved>.1,moved
        # Expression buttons set their channel and leave the performance running.
        assert await page.locator('#expressionRow button').count()==4
        await page.click('#expressionRow button[data-expression="expr.happy"]')
        await page.wait_for_timeout(200)
        assert float(await page.locator('input[data-parameter="expr.happy"]').input_value())==1
        assert await page.locator('#demoMode').is_checked()
        await page.click('#expressionRow button[data-expression="expr.sad"]')
        await page.wait_for_timeout(200)
        assert float(await page.locator('input[data-parameter="expr.happy"]').input_value())==0
        assert float(await page.locator('input[data-parameter="expr.sad"]').input_value())==1
        await page.click('#expressionRow button[data-expression="expr.sad"]')  # toggles off
        await page.wait_for_timeout(200)
        assert float(await page.locator('input[data-parameter="expr.sad"]').input_value())==0
        # Motion style defaults to energetic and switches without reloading.
        assert await page.locator('#motionStyle').input_value()=='energetic'
        assert await page.locator('#motionStyle option').count()==2
        async def head_travel():
            samples=[]
            for _ in range(24):
                samples.append(float(await page.locator('input[data-parameter="head.yaw"]').input_value()))
                await page.wait_for_timeout(125)
            return max(samples)-min(samples)
        lively=await head_travel()
        await page.select_option('#motionStyle','calm')
        await page.wait_for_timeout(300)
        assert await page.locator('#motionStyle').input_value()=='calm'
        assert lively>0.05,lively
        # Detection accuracy against the hand-reviewed regions in sample.js, on
        # both bundled renders. These are floors, not targets: they exist so a
        # change that quietly moves the face onto the chest fails the build.
        truth={'face':{'x':280,'y':180,'width':225,'height':190},
               'leftEye':{'x':295,'y':244,'width':66,'height':43},
               'rightEye':{'x':416,'y':231,'width':62,'height':44},
               'mouth':{'x':378,'y':315,'width':31,'height':16}}
        def iou(a,t):
            x0=max(a['x'],t['x']); y0=max(a['y'],t['y'])
            x1=min(a['x']+a['width'],t['x']+t['width']); y1=min(a['y']+a['height'],t['y']+t['height'])
            inter=max(0,x1-x0)*max(0,y1-y0)
            return inter/(a['width']*a['height']+t['width']*t['height']-inter or 1)
        detect_js="""async (asset) => {
          const mod = await import('./src/auto-rigger.js');
          const res = await fetch(asset);
          const bitmap = await createImageBitmap(await res.blob());
          const c = document.createElement('canvas');
          c.width = bitmap.width; c.height = bitmap.height;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(bitmap, 0, 0);
          const a = mod.analyzeImageData(ctx.getImageData(0, 0, c.width, c.height));
          return { face: a.face, leftEye: a.features.leftEye,
                   rightEye: a.features.rightEye, mouth: a.features.mouth };
        }"""
        # Floors, not targets. They were relaxed slightly when the face box was
        # anchored on the chin: that costs a little precision on these two and
        # is what makes a realistically drawn face work at all.
        for asset,floor in [('./static/kokoro-chan.webp',0.55),('./static/kokoro-chan-speak.webp',0.60)]:
            got=await page.evaluate(detect_js,asset)
            scores={k:iou(got[k],truth[k]) for k in truth}
            mean=sum(scores.values())/len(scores)
            assert scores['face']>.75,(asset,scores)
            assert mean>floor,(asset,mean,scores)
            for name,r in got.items():   # every feature must land on the face
                if name=='face': continue
                assert r['x']>=got['face']['x']-10 and r['y']>=got['face']['y']-10,(asset,name,r)
            detection[asset.split('/')[-1]]=round(mean,3)

        # The reviewer's answer shape changed once and the mismatch surfaced as an
        # undefined deep inside the rig builder. Both shapes must work, and a
        # reviewer that answers with nothing must say so readably.
        shapes_js="""async () => {
          const { autoRigFile } = await import('./src/auto-rigger.js');
          const res = await fetch('./static/kokoro-chan.webp');
          const file = new File([await res.blob()], 'k.webp', { type: 'image/webp' });
          const out = {};
          for (const [name, review] of [
            ['bare',   async (p) => p.regions],
            ['paired', async (p) => ({ regions: p.regions, analysis: p.analysis })],
            ['empty',  async () => undefined],
          ]) {
            try {
              const { model } = await autoRigFile(file, { review });
              out[name] = `built ${model.layers.length}`;
            } catch (e) { out[name] = `error: ${e.message}`; }
          }
          return out;
        }"""
        shapes=await page.evaluate(shapes_js)
        assert shapes['bare'].startswith('built'),shapes
        assert shapes['paired'].startswith('built'),shapes
        assert 'reload' in shapes['empty'],shapes

        # Review is required; invalid bounds cannot be built.
        await page.goto(os.environ.get("KOKORO_TEST_URL", "http://127.0.0.1:5173") + '/',wait_until='networkidle')
        await page.click('#autoRigButton')
        await page.locator('#autoRigInput').set_input_files('static/kokoro-chan.webp')
        await page.wait_for_selector('.region-editor')
        await page.click('.region-numeric summary')
        await page.get_by_label('Region width',exact=True).fill('0')
        assert await page.locator('.build-rig').is_disabled()
        await page.get_by_label('Region width',exact=True).fill('200')
        assert await page.locator('.build-rig').is_enabled()
        # The detect button is optional: present in the DOM, shown only when a
        # local vision model answers, and never required for the review to work.
        assert await page.locator('.detect-style').count()==1
        # The proportions selector re-estimates every rectangle from the same art.
        assert await page.locator('.style-select option').count()==2
        before=await page.get_by_label('Region height',exact=True).input_value()
        await page.select_option('.style-select','realistic')
        await page.wait_for_timeout(400)
        after=await page.get_by_label('Region height',exact=True).input_value()
        assert before!=after,(before,after)
        await page.select_option('.style-select','anime')
        await page.wait_for_timeout(400)
        # Initial placement may come from the optional anime detector, while
        # selecting proportions uses the image heuristic. Undo restores the
        # reviewed placement; selecting anime is a fresh estimate of it.
        assert await page.get_by_label('Region height',exact=True).input_value()!=after
        await page.click('.region-undo')
        assert await page.get_by_label('Region height',exact=True).input_value()==after
        await page.click('.region-undo')
        assert await page.get_by_label('Region height',exact=True).input_value()==before
        await page.click('.build-rig')
        await page.wait_for_selector('#autoRigReport:not([hidden])')
        assert 'alive' in await page.locator('#autoRigResultTitle').inner_text()
        # A hair region that ends up empty is dropped with its springs, so the
        # count is no longer fixed; it must still be a complete rig.
        built=await page.locator('#layerList .layer-row').count()
        assert built>=13,built
        await page.click('#autoRigClose')
        # Cancellation leaves the current model intact.
        page.on('dialog',lambda dialog:dialog.accept())
        await page.click('#autoRigButton')
        await page.locator('#autoRigInput').set_input_files('static/kokoro-chan.webp')
        await page.wait_for_selector('.region-editor')
        await page.click('#autoRigClose')
        assert await page.locator('#layerList .layer-row').count()==built
        # Files start playing even after a slider/manual pause. Model motion
        # settings travel with the file, and invalid files preserve the puppet.
        await page.goto(os.environ.get("KOKORO_TEST_URL", "http://127.0.0.1:5173") + '/viewer.html',wait_until='networkidle')
        await page.wait_for_selector('input[data-parameter="mouth.open"]')
        await page.uncheck('#demoMode')
        await page.locator('#viewerFile').set_input_files('interviewer.kokoro2d')
        await page.wait_for_function("document.querySelector('#puppetTitle').textContent === 'Interviewer'")
        assert await page.is_checked('#demoMode')
        assert await page.locator('#motionStyle').input_value() == 'calm'
        await page.mouse.move(0, 0)
        await page.wait_for_timeout(1200)
        first = await page.locator('input[data-parameter="head.yaw"]').input_value()
        await page.wait_for_timeout(1200)
        second = await page.locator('input[data-parameter="head.yaw"]').input_value()
        assert first != second, (first, second)
        assert float(await page.locator('input[data-parameter="mouth.open"]').input_value()) == 0
        await page.locator('#viewerCanvas').screenshot(path='/private/tmp/interviewer-idle.png')
        await page.check('#previewTalking')
        await page.wait_for_function("Number(document.querySelector('input[data-parameter=\"mouth.open\"]').value) > .2")
        await page.uncheck('#demoMode')
        await page.locator('input[data-parameter="mouth.open"]').fill('0.7')
        await page.locator('#viewerCanvas').screenshot(path='/private/tmp/interviewer-talking.png')
        await page.locator('#viewerFile').set_input_files({'name':'broken.kokoro2d','mimeType':'application/json','buffer':b'not json'})
        await page.wait_for_function("document.querySelector('#viewerStatus').dataset.tone === 'bad'")
        assert await page.locator('#puppetTitle').inner_text() == 'Interviewer'
        # Exercise drag/drop independently from the hidden file input.
        source_file = json.loads(Path('sample.kokoro2d').read_text())
        await page.uncheck('#demoMode')
        await page.evaluate("""text => {
            const transfer=new DataTransfer();
            transfer.items.add(new File([text],'sample.kokoro2d',{type:'application/json'}));
            document.querySelector('.viewer-stage-wrap').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));
        }""", json.dumps(source_file))
        await page.wait_for_function("document.querySelector('#puppetTitle').textContent === 'sample'")
        assert await page.is_checked('#demoMode')
        assert await page.locator('#motionStyle').input_value() == 'energetic'
        assert not await page.is_checked('#previewTalking')
        await browser.close()
    assert not errors,errors
    print({'layers':count,'rebuilt_layers':built,'detection_mean_iou':detection,'export_and_import':'passed','gaze':'passed','placement_and_cancel':'passed','errors':errors})

asyncio.run(main())
