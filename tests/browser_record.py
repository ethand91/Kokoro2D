"""Run against npm start: python3 tests/browser_record.py (requires Playwright and ffprobe)."""
import os
import asyncio
import json
import subprocess
import tempfile
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path(tempfile.gettempdir())


def probe(path):
    raw = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                          'stream=codec_type,codec_name,width,height', '-of', 'json', str(path)],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(raw)['streams']


async def take(page, seconds, during=None):
    async with page.expect_download() as pending:
        await page.click('#recordButton')
        assert 'recording' in (await page.get_attribute('#recordButton', 'class') or '')
        await page.wait_for_timeout(seconds * 1000 // 2)
        if during:
            await during()
        await page.wait_for_timeout(seconds * 1000 // 2)
        await page.click('#recordButton')
    download = await pending.value
    path = OUT / download.suggested_filename
    await download.save_as(path)
    assert await page.inner_text('#recordButton') == '⏺ Record WebM'
    return path


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=[
            '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'])
        context = await browser.new_context(permissions=['microphone'],
                                            viewport={'width': 1280, 'height': 900})
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(os.environ.get("KOKORO_TEST_URL", "http://127.0.0.1:5173") + '/viewer.html')
        await page.wait_for_function("document.querySelectorAll('#viewerControls .viewer-control').length > 3")
        assert not await page.is_disabled('#recordButton')

        silent = await take(page, 3)
        assert silent.name.startswith('kokoro-chan-'), silent.name
        assert silent.read_bytes()[:4] == b'\x1a\x45\xdf\xa3', 'not a WebM container'
        assert silent.stat().st_size > 20_000, silent.stat().st_size
        streams = probe(silent)
        assert [s['codec_type'] for s in streams] == ['video'], streams
        video = streams[0]
        assert video['width'] % 2 == 0 and video['height'] % 2 == 0, video  # odd sizes fail some encoders
        assert 'Saved' in await page.inner_text('#viewerStatus')

        # The stage canvas is cleared to transparent; a take must still carry the
        # backdrop rather than encoding the character onto a black void.
        frame = OUT / 'kokoro-record-frame.png'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(silent),
                        '-vf', 'select=eq(n\\,30)', '-vframes', '1', str(frame)], check=True)
        corner = subprocess.run(['ffprobe', '-v', 'error', '-f', 'lavfi', '-i',
                                 f'movie={frame},crop=24:24:0:0,signalstats', '-show_entries',
                                 'frame_tags=lavfi.signalstats.YAVG', '-of', 'csv=p=0'],
                                capture_output=True, text=True, check=True).stdout.strip()
        assert float(corner.split(',')[0]) > 16, f'backdrop encoded as black: {corner}'

        # Microphone audio rides along, and stopping the take must not stop the
        # borrowed tracks: the lip sync has to survive its own recording.
        await page.click('#enableMic')
        await page.wait_for_function("document.querySelector('#enableMic').getAttribute('aria-pressed') === 'true'")
        voiced = await take(page, 2)
        assert [s['codec_type'] for s in probe(voiced)] == ['video', 'audio'], probe(voiced)
        await page.wait_for_timeout(300)
        assert 'Disable microphone' in await page.inner_text('#enableMic')
        assert errors == [], errors

        # Resizing retargets the renderer's backing store. The take's frame size
        # is fixed at the start, or the encoded track changes shape mid-file.
        async def shrink():
            await page.set_viewport_size({'width': 700, 'height': 1000})
        resized = await take(page, 3, during=shrink)
        after = probe(resized)[0]
        assert (after['width'], after['height']) == (video['width'], video['height']), (after, video)

        assert errors == [], errors
        print(f"Recorded {video['width']}x{video['height']} VP9; audio, backdrop, and mid-take resize passed.")
        await browser.close()


asyncio.run(main())
