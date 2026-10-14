"""Reviewed default rig: run with npm start and Python Playwright installed."""
import os
import asyncio
import base64
import json
from pathlib import Path
from playwright.async_api import async_playwright


async def main():
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on("pageerror", lambda error: errors.append(str(error)))
        await page.goto(os.environ.get("KOKORO_TEST_URL", "http://127.0.0.1:5173") + '/', wait_until="networkidle")
        await page.wait_for_function("document.querySelectorAll('#layerList .layer-row').length === 18")
        async with page.expect_download() as info:
            await page.click("#exportModel")
        model = json.loads(Path(await (await info.value).path()).read_text())
        assert model["meta"]["rigRevision"] == 4
        assert model["meta"]["regions"]["mouth"]["sourceClosed"]
        assert any(layer["name"] == "Mouth • original closed lips" for layer in model["layers"])
        await page.goto(os.environ.get("KOKORO_TEST_URL", "http://127.0.0.1:5173") + '/viewer.html', wait_until="networkidle")
        await page.wait_for_selector('input[data-parameter="mouth.open"]')
        assert "from the Maker" in await page.locator("#viewerStatus").inner_text()
        await page.locator("#viewerFile").set_input_files({"name": "upgraded.kokoro2d", "mimeType": "application/json", "buffer": json.dumps(model).encode()})
        await page.wait_for_timeout(200)
        assert await page.locator("#puppetTitle").inner_text() == "Kokoro-chan"

        # Render in a document without the Viewer animation loop, so changing
        # the preview DOM cannot invalidate its live UI controls.
        await page.goto(os.environ.get("KOKORO_TEST_URL", "http://127.0.0.1:5173") + '/static/', wait_until="networkidle")

        report = await page.evaluate("""async (model) => {
          const { KokoroRenderer } = await import('/src/renderer.js');
          const { createModel, createLayer, defaultParameterValues, validateModel } = await import('/src/model.js');
          const { evaluateScene } = await import('/src/scene.js');
          if (validateModel(model).length) throw Error(validateModel(model).join('; '));
          document.body.replaceChildren();
          document.body.style.cssText = 'margin:0;background:#21162b;display:flex;flex-wrap:wrap';
          const canvas = document.createElement('canvas');
          canvas.style.cssText = 'width:720px;height:1000px';document.body.append(canvas);
          const r = new KokoroRenderer(canvas);r.camera.zoom=1;
          await r.setModel(model);
          const neutral=defaultParameterValues(model);
          const capture=(values)=>{r.render({...neutral,...values});const out=new Uint8Array(r.gl.drawingBufferWidth*r.gl.drawingBufferHeight*4);r.gl.readPixels(0,0,r.gl.drawingBufferWidth,r.gl.drawingBufferHeight,r.gl.RGBA,r.gl.UNSIGNED_BYTE,out);return out;};
          const base=capture({});
          const half=capture({'eyes.blink':.5});
          const backing=model.layers.find(l=>l.name==='Portrait Seam Backing');
          const scale=backing.source.width/768,W=r.gl.drawingBufferWidth,H=r.gl.drawingBufferHeight;
          let lowerDifference=0,lowerSamples=0;
          for(const [sx,sy] of [[333,281],[444,268]])for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++) {
            const x=Math.round(W/2+backing.transform.x+(sx-384)*scale)+dx;
            const y=Math.round(H/2-backing.transform.y-(sy-576)*scale)+dy;
            for(let c=0;c<3;c++){const at=(y*W+x)*4+c;lowerDifference+=Math.abs(base[at]-half[at]);lowerSamples++;}
          }
          const purple=(pixels)=>{
            let count=0;
            const W=r.gl.drawingBufferWidth,H=r.gl.drawingBufferHeight;
            // Source irises sit here at neutral, in model-space coordinates.
            for(const [cx,cy] of [[-40,-240],[46,-250]])for(let y=-7;y<=7;y++)for(let x=-7;x<=7;x++) {
              const at=(Math.round(H/2-cy-y)*W+Math.round(W/2+cx+x))*4;
              if(pixels[at+2]>pixels[at+1]*1.15 && pixels[at+2]>pixels[at]*.9)count++;
            }
            return count;
          };
          const closed=capture({'eyes.blink':1});
          const closedStars=capture({'eyes.blink':1,'expr.happy':1,'eyes.lookX':1,'eyes.lookY':1});
          const differences=(a,b)=>a.reduce((sum,v,i)=>sum+Math.abs(v-b[i]),0)/a.length;
          const openStars=capture({'expr.happy':1});
          const gaze=capture({'eyes.lookX':1,'eyes.lookY':-1});
          const lips=model.layers.find(l=>l.name==='Mouth • original closed lips');
          const mouth=model.layers.find(l=>l.name.startsWith('Mouth • open'));
          const poses=evaluateScene(model,neutral), talking=evaluateScene(model,{...neutral,'mouth.open':1});
          const results={openPurple:purple(base),closedPurple:purple(closed),closedStarPurple:purple(closedStars),
            lowerIrisDifference:lowerDifference/lowerSamples,
            starDifference:differences(base,openStars),gazeDifference:differences(base,gaze),
            restingLips:poses.get(lips.id).transform.opacity,restingCavity:poses.get(mouth.id).transform.opacity,
            talkingLips:talking.get(lips.id).transform.opacity,talkingCavity:talking.get(mouth.id).transform.opacity};
          // Compare neutral paint with the original portrait at identical scale.
          const reference=createModel();reference.layers=[createLayer({name:'Original',src:'/static/kokoro-chan.webp',width:backing.source.width,height:backing.source.height,x:backing.transform.x,y:backing.transform.y})];
          await r.setModel(reference);const art=capture({});results.neutralDifference=differences(base,art);
          const isolated=structuredClone(model);
          for(const layer of isolated.layers) {
            const eye=/Iris|Eye Opening|Eye Stars/.test(layer.name);
            layer.visible=eye;
            if(layer.name.includes('Eye Opening'))layer.maskOnly=true;
          }
          await r.setModel(isolated);
          const alphaCount=pixels=>{let count=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>128)count++;return count;};
          results.isolatedOpen=alphaCount(capture({}));
          results.isolatedClosed=alphaCount(capture({'eyes.blink':1}));
          results.isolatedClosedStars=alphaCount(capture({'eyes.blink':1,'expr.happy':1,'eyes.lookX':1,'eyes.lookY':1}));
          await r.setModel(model);r.render(neutral);
          // Larger head crops make eyelids, lips and seams easy to inspect.
          canvas.style.height='500px';r.camera={x:6,y:-240,zoom:2.3};r.render(neutral);
          const neutralCanvas=document.createElement('canvas');neutralCanvas.width=720;neutralCanvas.height=500;
          neutralCanvas.style.cssText='width:720px;height:500px';neutralCanvas.getContext('2d').drawImage(canvas,0,0);
          canvas.style.position='fixed';canvas.style.left='-10000px';document.body.append(neutralCanvas);
          for(const values of [{'eyes.blink':.5},{'eyes.blink':1},{'head.yaw':1,'head.pitch':-.6,'head.roll':.4,'eyes.lookX':1,'mouth.open':.7,'mouth.round':1}]) {
            const snapshot=document.createElement('canvas');snapshot.width=720;snapshot.height=500;snapshot.style.cssText='width:720px;height:500px';
            r.render({...neutral,...values});snapshot.getContext('2d').drawImage(canvas,0,0);document.body.append(snapshot);
          }
          const stream=canvas.captureStream(30),recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];
          results.recording=await new Promise((resolve,reject)=>{
            recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
            recorder.onerror=reject;
            recorder.onstop=()=>{stream.getTracks().forEach(track=>track.stop());const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(new Blob(chunks,{type:'video/webm'}));};
            r.render(neutral);recorder.start();
            const start=performance.now(),smooth=t=>{const v=Math.max(0,Math.min(1,t));return v*v*(3-2*v);};
            const frame=now=>{
              const time=(now-start)/1000;
              let blink=0;
              for(const at of [.65,1.9]){const t=time-at;if(t>=0&&t<.08)blink=smooth(t/.08);else if(t>=.08&&t<.125)blink=1;else if(t>=.125&&t<.305)blink=1-smooth((t-.125)/.18);}
              r.render({...neutral,'eyes.blink':blink});
              if(time<3)requestAnimationFrame(frame);else recorder.stop();
            };requestAnimationFrame(frame);
          });
          r.disposeResources();canvas.remove();return results;
        }""", model)
        Path("/private/tmp/kokoro2d-natural-blink.webm").write_bytes(base64.b64decode(report.pop("recording")))
        print(json.dumps(report, indent=2))
        await page.screenshot(path="/private/tmp/kokoro2d-upgraded-rig.png")
        assert report["restingLips"] == report["talkingCavity"] == 1, report
        assert report["restingCavity"] == report["talkingLips"] == 0, report
        assert report["openPurple"] > 100, report
        assert report["lowerIrisDifference"] < 1, report
        assert report["isolatedOpen"] > 1000, report
        assert report["isolatedClosed"] == report["isolatedClosedStars"] == 0, report
        assert report["starDifference"] > .01 and report["gazeDifference"] > .01, report
        assert report["neutralDifference"] < 2, report
        assert not errors, errors
        await browser.close()
    print("Default rig export, import, painted eyes, blink clipping, lips and neutral artwork passed")


asyncio.run(main())
