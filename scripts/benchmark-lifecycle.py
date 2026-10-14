"""Headless synthetic renderer/load/switch/record benchmark; no telemetry package.
--baseline-ref HEAD compares the committed renderer with the working tree using
identical current model/texture dependencies. Outputs raw JSON, not GPU timings.
"""
import argparse
import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
from playwright.async_api import async_playwright

async def main(args):
    async with async_playwright() as p:
        browser = await getattr(p, args.browser).launch(headless=True)
        page = await browser.new_page(viewport={'width':900,'height':700})
        await page.goto(os.environ.get('KOKORO_TEST_URL','http://127.0.0.1:5173')+'/viewer.html')
        # Stop the visible Viewer consuming benchmark frame time/GPU resources.
        await page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))")
        result = {'at':datetime.now(timezone.utc).isoformat(),'browser':args.browser,'userAgent':await page.evaluate('navigator.userAgent'),'viewport':[640,480],'method':'120 frames after 20 warmup; 10 switches; 30 recorded frames; synthetic independent deformed 8x8 meshes; 10 capture start/stop cycles'}
        if args.baseline_ref:
            source = subprocess.check_output(['git','show',args.baseline_ref+':src/renderer.js'], text=True)
            result['baselineRef'] = subprocess.check_output(['git','rev-parse',args.baseline_ref],text=True).strip()
            result['before'] = await page.evaluate("""async source => {
              const code=source.replaceAll('"./','"'+location.origin+'/src/');
              const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
              try {const {KokoroRenderer}=await import(url);return (await import('/tests/browser_performance.js')).measureRenderer(KokoroRenderer);}finally{URL.revokeObjectURL(url);}
            }""", source)
        result['after'] = await page.evaluate("async()=> (await import('/tests/browser_performance.js')).measureRenderer((await import('/src/renderer.js')).KokoroRenderer)")
        await browser.close()
        Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result),flush=True)

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--browser',choices=['chromium','firefox'],default='chromium')
    parser.add_argument('--baseline-ref')
    parser.add_argument('--output',default='/private/tmp/kokoro-lifecycle-benchmark.json')
    asyncio.run(asyncio.wait_for(main(parser.parse_args()),timeout=180))
