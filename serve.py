"""Local no-cache server with optional anime landmark inference.

Set KOKORO_ANIME_PYTHON to a Python with anime-face-detector installed.
Images are processed locally; only model weights may download on first use.
"""
import functools
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, test
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
INFERENCE_LOCK = threading.Lock()
MAX_IMAGE_BYTES = 12 * 1024 * 1024


@functools.lru_cache(maxsize=1)
def anime_python():
    configured = os.environ.get("KOKORO_ANIME_PYTHON")
    conda = shutil.which("conda")
    candidates = [configured] if configured else [
        str(ROOT / ".venv-anime/bin/python"), sys.executable,
        str(Path(conda).resolve().parent.parent / "bin/python") if conda else None,
    ]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            probe = subprocess.run(
                [candidate, "-c", "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('anime_face_detector') else 1)"],
                capture_output=True, timeout=5,
            )
            if probe.returncode == 0:
                return candidate
        except (OSError, subprocess.TimeoutExpired):
            pass
    return None


class NoStoreHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def reply(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/anime-landmarks":
            self.reply(200, {"available": anime_python() is not None})
        else:
            super().do_GET()

    def do_POST(self):
        if self.path != "/api/anime-landmarks":
            self.reply(404, {"error": "Unknown endpoint."})
            return
        # Only the local editor may invoke the relatively expensive worker.
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            self.reply(403, {"error": "Use the detector from the local editor."})
            return
        if self.headers.get("Content-Type") != "image/png":
            self.reply(415, {"error": "Send a PNG image."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= MAX_IMAGE_BYTES:
            self.reply(413, {"error": "Image is empty or larger than 12 MB."})
            return
        python = anime_python()
        if not python:
            self.reply(503, {"error": "Anime detector is not installed. See README setup instructions."})
            return
        if not INFERENCE_LOCK.acquire(blocking=False):
            self.reply(429, {"error": "Anime detector is busy. Try again shortly."})
            return
        try:
            result = subprocess.run(
                [python, str(ROOT / "scripts/anime_landmarks.py")],
                input=self.rfile.read(length), capture_output=True, timeout=120, cwd=ROOT,
            )
            if result.returncode:
                print(result.stderr.decode(errors="replace")[-3000:], file=sys.stderr)
                self.reply(503, {"error": "Anime detection failed. Check the server terminal for model or dependency errors."})
            else:
                self.reply(200, json.loads(result.stdout))
        except subprocess.TimeoutExpired:
            self.reply(504, {"error": "Anime detection timed out. Try again after model setup finishes."})
        except (ValueError, OSError):
            self.reply(503, {"error": "Anime detector returned an invalid response."})
        finally:
            INFERENCE_LOCK.release()


if __name__ == "__main__":
    test(NoStoreHandler, port=int(sys.argv[1]) if len(sys.argv) > 1 else 5173, bind="127.0.0.1")
