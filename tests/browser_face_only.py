"""Run against npm start: python3 tests/browser_face_only.py (requires Playwright)."""
import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda dialog: dialog.accept())
        await page.goto('http://127.0.0.1:5173/')
        await page.wait_for_function("document.querySelectorAll('#layerList .layer-row').length > 10")
        await page.click('#autoRigButton')
        assert not await page.is_checked('#autoRigFaceOnly')
        await page.check('#autoRigFaceOnly')
        await page.set_input_files('#autoRigInput', str(Path(__file__).resolve().parents[1] / 'static/kokoro-chan.webp'))
        await page.wait_for_selector('.build-rig')
        assert await page.is_disabled('#autoRigFaceOnly')
        regions = await page.locator('.region-select option').evaluate_all('(options) => options.map(o => o.value)')
        assert regions == ['face', 'leftEye', 'rightEye', 'mouth'], regions
        initial = await page.evaluate("""async () => {
            const { prepareAutoRig } = await import('/src/auto-rigger.js');
            const blob = await (await fetch('/static/kokoro-chan.webp')).blob();
            return (await prepareAutoRig(new File([blob], 'test.webp', {type:'image/webp'}))).regions;
        }""")
        await page.select_option('.region-select', 'leftEye')
        await page.locator('.region-zoom').fill('3')
        await page.locator('.region-viewport').scroll_into_view_if_needed()
        original = initial['leftEye']['contour'][0]
        position = await page.evaluate("""point => {
            const viewport=document.querySelector('.region-viewport');
            const canvas=viewport.querySelector('canvas');
            const scale=canvas.getBoundingClientRect().width/canvas.width;
            viewport.scrollLeft=Math.max(0,point[0]*scale-viewport.clientWidth/2);
            viewport.scrollTop=Math.max(0,point[1]*scale-viewport.clientHeight/2);
            const rect=canvas.getBoundingClientRect();
            return {x:rect.left+point[0]*scale,y:rect.top+point[1]*scale,scale};
        }""", original)
        # Move the left eye corner, undo/redo it, then nudge it with the keyboard.
        await page.mouse.move(position['x'], position['y'])
        await page.mouse.down()
        await page.mouse.move(position['x']-3*position['scale'], position['y']+2*position['scale'], steps=4)
        await page.mouse.up()
        assert await page.locator('.build-rig').is_enabled()
        await page.click('.region-undo')
        await page.click('.region-redo')
        # Undo and redo clear the selected point; select the moved corner again.
        await page.mouse.click(position['x']-3*position['scale'], position['y']+2*position['scale'])
        await page.keyboard.press('ArrowDown')
        # Double-click a lid edge to insert a point, then delete that point.
        a, b = initial['leftEye']['contour'][4:6]
        mid = [(a[0]+b[0])/2, (a[1]+b[1])/2]
        target = await page.locator('.region-viewport canvas').evaluate("""(canvas, p) => {
            const rect=canvas.getBoundingClientRect(),scale=rect.width/canvas.width;
            return {x:rect.left+p[0]*scale,y:rect.top+p[1]*scale};
        }""", mid)
        await page.mouse.dblclick(target['x'], target['y'])
        await page.keyboard.press('Delete')
        await page.locator('.region-viewport').screenshot(path='/private/tmp/kokoro-outline-editor.png')
        await page.click('.build-rig')
        await page.wait_for_selector('#autoRigReport:not([hidden])')
        assert 'is alive' in await page.locator('#autoRigResultTitle').inner_text()
        await page.click('#autoRigClose')
        async with page.expect_download() as info:
            await page.click('#exportModel')
        model = json.loads(Path(await (await info.value).path()).read_text())
        allowed = {'eyes.blink', 'mouth.open', 'mouth.form', 'mouth.round'}
        assert len(model['meta']['regions']['leftEye']['contour']) == 16
        actual = model['meta']['regions']['leftEye']['contour'][0]
        assert abs(actual[0] - (original[0]-3)) < 0.1, (actual, original)
        assert abs(actual[1] - (original[1]+3)) < 0.1, (actual, original)
        assert set(model['parameters']) == allowed
        assert model['physics'] == []
        assert model['meta']['autoRig']['faceOnly'] is True
        assert len(model['layers']) == 8
        base = model['layers'][0]
        assert base['name'] == 'Character' and base['keyforms'] == {}
        for layer in model['layers']:
            assert set(layer['keyforms']) <= allowed
        assert sum('eyes.blink' in layer['keyforms'] for layer in model['layers']) == 4
        assert any('mouth.open' in layer['keyforms'] for layer in model['layers'])
        assert await page.locator('#parameterSelect').input_value() in allowed
        # Limited rigs must also survive export/import into the scene evaluator.
        validation = await page.evaluate('''async model => {
            const { validateModel, serializeModel, parseModel } = await import('/src/model.js');
            const { contourPath, eyeProfile } = await import('/src/region-geometry.js');
            const eye=model.layers.find(l=>l.name==='Left Eye Opening');
            const r=model.meta.regions.leftEye;
            if(!decodeURIComponent(eye.source.src).includes(contourPath(r,true)))throw new Error('Edited outline missing from eye artwork');
            const scale=eye.source.width/r.width;
            const blink=eye.keyforms['eyes.blink'][0];
            for(let i=0;i<eye.mesh.vertices.length;i+=2) {
                const expected=(eyeProfile(r,eye.mesh.uvs[i]).closed-r.y-r.height/2)*scale;
                const actual=eye.mesh.vertices[i+1]+blink.offsets[i+1];
                if(Math.abs(actual-expected)>.001)throw new Error('Blink does not follow edited corners');
            }
            return validateModel(parseModel(serializeModel(model)));
        }''', model)
        assert validation == [], validation
        # Direct auto-rig calls also recover the exact crossed-edge failure,
        # in both modes, without modifying the caller's placement data.
        recovery = await page.evaluate("""async () => {
            const {prepareAutoRig}=await import('/src/auto-rigger.js');
            const {buildLayeredRig}=await import('/src/layered-rig.js');
            const {validContour}=await import('/src/region-geometry.js');
            const {validateModel}=await import('/src/model.js');
            const blob=await (await fetch('/static/kokoro-chan.webp')).blob();
            const p=await prepareAutoRig(new File([blob],'test.webp',{type:'image/webp'}));
            const r=p.regions.mouth;r.sourceClosed=true;
            r.contour=[[r.x,r.y],[r.x+r.width,r.y+r.height],[r.x,r.y+r.height],[r.x+r.width,r.y]];
            const before=JSON.stringify(p.regions);
            for(const faceOnly of [true,false]) {
                const m=buildLayeredRig(p.imageData,p.analysis,p.regions,'Recovery',{faceOnly});
                if(validateModel(m).length) return false;
                if(!validContour(m.meta.regions.mouth.contour,p.imageData.width,p.imageData.height))return false;
            }
            return before===JSON.stringify(p.regions);
        }""")
        assert recovery is True
        # A closed lip line can recover from zero height and produce a talking rig.
        await page.click('#autoRigButton')
        await page.set_input_files('#autoRigInput', str(Path(__file__).resolve().parents[1] / 'static/kokoro-chan.webp'))
        await page.wait_for_selector('.build-rig')
        await page.select_option('.region-select', 'mouth')
        await page.click('.region-numeric summary')
        await page.get_by_label('Region height', exact=True).fill('0')
        assert await page.locator('.build-rig').is_disabled()
        await page.check('.mouth-closed')
        assert await page.locator('.build-rig').is_enabled()
        assert 'repaired automatically' in await page.locator('.region-feedback').inner_text()
        await page.get_by_label('Region height', exact=True).fill('0')
        assert await page.locator('.build-rig').is_enabled()
        assert float(await page.get_by_label('Region height', exact=True).input_value()) >= 2
        await page.get_by_label('Region height', exact=True).fill('2')
        assert await page.locator('.build-rig').is_enabled()
        await page.click('.build-rig')
        await page.wait_for_selector('#autoRigReport:not([hidden])')
        assert 'is alive' in await page.locator('#autoRigResultTitle').inner_text()
        await page.click('#autoRigClose')
        async with page.expect_download() as info:
            await page.click('#exportModel')
        closed = json.loads(Path(await (await info.value).path()).read_text())
        assert closed['meta']['regions']['mouth']['sourceClosed'] is True
        assert len(closed['layers']) == 9
        result = await page.evaluate("""async model => {
            const {evaluateLayer,validateModel}=await import('/src/model.js');
            const lips=model.layers.find(l=>l.name==='Mouth • original closed lips');
            const mouth=model.layers.find(l=>l.name==='Mouth • open / wide / rounded');
            const pose=(layer,open)=>evaluateLayer(layer,{'mouth.open':open},model.parameters);
            const resting=pose(mouth,0),talking=pose(mouth,1);
            const height=p=>Math.max(...p.vertices.filter((_,i)=>i%2))-Math.min(...p.vertices.filter((_,i)=>i%2));
            return {errors:validateModel(model),lipRest:pose(lips,0).transform.opacity,
              lipTalking:pose(lips,1).transform.opacity,openRest:resting.transform.opacity,
              openTalking:talking.transform.opacity,restHeight:height(resting),talkHeight:height(talking)};
        }""", closed)
        assert result['errors'] == [], result
        assert result['lipRest'] == 1 and result['lipTalking'] == 0, result
        assert result['openRest'] == 0 and result['openTalking'] == 1, result
        assert result['talkHeight'] > result['restHeight'] * 5, result
        assert errors == [], errors
        print('Closed-mouth reset, source lips at rest, and generated speech opening passed.')
        print('Outline drag, zoom, undo/redo, keyboard nudge, blink geometry, build, export, and schema checks passed.')
        await browser.close()


asyncio.run(main())
