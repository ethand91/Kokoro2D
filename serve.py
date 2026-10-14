"""Local no-cache server with optional anime landmark inference.

Set KOKORO_ANIME_PYTHON to a Python with anime-face-detector installed.
Images are processed locally; only model weights may download on first use.
"""
import base64
import binascii
from collections import deque
import time
import shlex
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
CONTROL_LOCK = threading.Lock()
CONTROL_EVENTS = deque(maxlen=256)
CONTROL_SEQUENCE = 0
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

    def local_request(self):
        origin = self.headers.get("Origin")
        return not origin or urlsplit(origin).netloc == self.headers.get("Host")

    def do_GET(self):
        if urlsplit(self.path).path == "/api/control":
            if not self.local_request():
                self.reply(403, {"error": "Use controls from the local Viewer."})
                return
            from urllib.parse import parse_qs
            try:
                after = int(parse_qs(urlsplit(self.path).query).get("after", ["0"])[0])
            except ValueError:
                self.reply(400, {"error": "Invalid control cursor."})
                return
            with CONTROL_LOCK:
                events = [event for event in CONTROL_EVENTS if event["sequence"] > after and time.time() - event["at"] < 15]
                self.reply(200, {"sequence": CONTROL_SEQUENCE, "events": events})
        elif self.path == "/api/reconstruct":
            self.reply(200, {"available": bool(os.environ.get("KOKORO_RECONSTRUCT_COMMAND"))})
        elif self.path == "/api/anime-landmarks":
            self.reply(200, {"available": anime_python() is not None})
        else:
            super().do_GET()

    def do_POST(self):
        if self.path in ("/api/control", "/api/reconstruct"):
            if not self.local_request():
                self.reply(403, {"error": "Use the endpoint from the local app."})
                return
            if self.headers.get("Content-Type") != "application/json":
                self.reply(415, {"error": "Send JSON."})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                limit = 64 * 1024 if self.path == "/api/control" else MAX_IMAGE_BYTES * 3
                if not 0 < length <= limit:
                    raise ValueError("Request is empty or too large.")
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise ValueError("Expected a JSON object.")
                if self.path == "/api/control":
                    global CONTROL_SEQUENCE
                    if payload.get("type") not in ("parameters", "expression", "reset", "speech", "visemes"):
                        raise ValueError("Unknown control type.")
                    with CONTROL_LOCK:
                        CONTROL_SEQUENCE += 1
                        CONTROL_EVENTS.append({"sequence": CONTROL_SEQUENCE, "at": time.time(), "command": payload})
                        sequence = CONTROL_SEQUENCE
                    self.reply(200, {"sequence": sequence})
                else:
                    self.reconstruct(payload)
            except (ValueError, TypeError) as error:
                self.reply(400, {"error": str(error)})
            return
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

    def reconstruct(self, payload):
        command = os.environ.get("KOKORO_RECONSTRUCT_COMMAND")
        if not command:
            self.reply(503, {"error": "No local repair helper configured. Set KOKORO_RECONSTRUCT_COMMAND; see README."})
            return
        for key in ("image", "mask"):
            value = payload.get(key, "")
            if not isinstance(value, str) or not value.startswith("data:image/png;base64,"):
                raise ValueError("Send PNG image and mask data URLs.")
            try:
                raw = base64.b64decode(value.split(",", 1)[1], validate=True)
            except (ValueError, binascii.Error) as error:
                raise ValueError("Invalid repair PNG.") from error
            if len(raw) > MAX_IMAGE_BYTES or not raw.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("Invalid or oversized repair PNG.")
        if not INFERENCE_LOCK.acquire(blocking=False):
            self.reply(429, {"error": "Local inference is busy."})
            return
        try:
            result = subprocess.run(shlex.split(command), input=json.dumps({"image": payload["image"], "mask": payload["mask"]}).encode(), capture_output=True, timeout=180, cwd=ROOT)
            if result.returncode or len(result.stdout) > MAX_IMAGE_BYTES * 2:
                self.reply(503, {"error": "Local repair helper failed. Check its setup."})
                return
            response = json.loads(result.stdout)
            value = response.get("image", "")
            if not isinstance(value, str) or not value.startswith("data:image/png;base64,"):
                raise ValueError("Repair helper must return a PNG data URL.")
            self.reply(200, {"image": value})
        except subprocess.TimeoutExpired:
            self.reply(504, {"error": "Local repair timed out."})
        except (OSError, ValueError):
            self.reply(503, {"error": "Invalid response from the local repair helper."})
        finally:
            INFERENCE_LOCK.release()


if __name__ == "__main__":
    test(NoStoreHandler, port=int(sys.argv[1]) if len(sys.argv) > 1 else 5173, bind="127.0.0.1")
