"""Run against npm start: python3 tests/browser_speech.py.

Mock OS speech events to check timing and cancellation deterministically.
This exercises real rendering and controls, but does not test audible output.
"""
import os
import asyncio
from playwright.async_api import async_playwright


async def main():
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on("pageerror", lambda error: errors.append(str(error)))
        await page.add_init_script("""
          localStorage.setItem('kokoro2d.speechRate', '4');
          window.testSpeech = { utterances: [], cancelled: 0 };
          Object.defineProperty(window, 'speechSynthesis', { value: {
            getVoices: () => [],
            cancel: () => { window.testSpeech.cancelled++; },
            speak: utterance => { window.testSpeech.utterances.push(utterance); }
          }});
        """)
        await page.goto(os.environ.get("KOKORO_TEST_URL", "http://127.0.0.1:5173") + '/viewer.html', wait_until="networkidle")
        await page.wait_for_selector('input[data-parameter="mouth.open"]')
        assert await page.locator("#speechGestures").is_checked()
        # Isolate speech from the occasional resting-mouth movement.
        await page.locator("#tuner").evaluate("el => el.open = true")
        await page.locator("#tunerControls .tune-row").filter(has_text="Idle mouth movement").locator("input").evaluate("""el => {
          el.value = 0; el.dispatchEvent(new Event('input', { bubbles: true }));
        }""")
        await page.locator("#tuner").evaluate("el => el.open = false")

        async def event(callback, index=-1, **data):
            await page.evaluate("""({ name, index, data }) => {
              const list = window.testSpeech.utterances;
              const utterance = list[index < 0 ? list.length + index : index];
              utterance[name]?.(data);
            }""", {"name": callback, "index": index, "data": data})

        await page.fill("#speakText", "aaa bubble")
        await page.locator("#speakText").press("Control+Enter")
        assert await page.locator("#speakButton").is_disabled(), "queued speech blocks duplicate submission"
        await event("onstart")
        await page.wait_for_function("Number(document.querySelector('input[data-parameter=\"mouth.open\"]').value) > 0.8")
        # Early boundary jumps from the open vowel to bubble's closed b.
        await event("onboundary", name="word", charIndex=4)
        await page.wait_for_function("Number(document.querySelector('input[data-parameter=\"mouth.open\"]').value) < 0.02", timeout=1000)
        await page.click("#speakStop")
        assert await page.locator("#speakButton").is_enabled()
        assert await page.locator("#speakStatus").inner_text() == ""

        # Cancelled callbacks cannot finish or restart a subsequent utterance.
        await page.fill("#speakText", "Wonderful adventures?")
        await page.click("#speakButton")
        await event("onstart")
        await event("onend", index=0)
        await event("onerror", index=0)
        await event("onstart", index=0)
        assert await page.locator("#speakButton").is_disabled()
        assert await page.locator("#speakStatus").inner_text() == "speaking…"
        await page.locator("#speechGestures").uncheck()
        assert await page.locator("#demoMode").is_checked()
        await page.locator("#speechGestures").check()
        await event("onend")
        assert await page.locator("#speakButton").is_enabled()
        assert "chars/s" in await page.locator("#speakStatus").inner_text()
        await page.wait_for_function("Number(document.querySelector('input[data-parameter=\"mouth.open\"]').value) < 0.02", timeout=1000)

        # No boundary support still drives the estimated track.
        await page.fill("#speakText", "aaa")
        await page.click("#speakButton")
        await event("onstart")
        await page.wait_for_function("Number(document.querySelector('input[data-parameter=\"mouth.open\"]').value) > 0.7")
        await event("onerror")
        assert await page.locator("#speakButton").is_enabled()
        assert "could not play" in await page.locator("#speakStatus").inner_text()
        assert await page.locator("#viewerStatus").inner_text() == "Speech unavailable"
        await page.fill("#speakText", "Wonderful adventures? No, let's stay here together.")
        await page.click("#speakButton")
        await event("onstart")
        await page.screenshot(path="/private/tmp/kokoro2d-speech-performance.png")
        await page.click("#speakStop")
        assert not errors, errors
        await browser.close()
    print("PASS: speech timing, lip closure, cancellation, fallback, and controls")


if __name__ == "__main__":
    asyncio.run(main())
