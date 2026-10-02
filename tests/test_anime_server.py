"""Standard-library tests; no detector weights or browser required."""
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import serve


class AnimeEndpointTests(unittest.TestCase):
    def request(self, headers=None, body=b'png'):
        handler = object.__new__(serve.NoStoreHandler)
        handler.path = '/api/anime-landmarks'
        handler.headers = {'Content-Type': 'image/png', 'Content-Length': str(len(body)), 'Host': '127.0.0.1:5173', **(headers or {})}
        handler.rfile = io.BytesIO(body)
        handler.responses = []
        handler.reply = lambda status, result: handler.responses.append((status, result))
        handler.do_POST()
        return handler.responses[0]

    def test_rejects_foreign_origin_and_oversized_payload_before_inference(self):
        with patch('serve.subprocess.run') as run:
            self.assertEqual(self.request({'Origin': 'https://example.com'})[0], 403)
            self.assertEqual(self.request({'Content-Length': str(serve.MAX_IMAGE_BYTES + 1)})[0], 413)
            self.assertEqual(self.request({'Content-Type': 'text/plain'})[0], 415)
            run.assert_not_called()

    def test_missing_environment_is_reported(self):
        with patch('serve.anime_python', return_value=None):
            self.assertEqual(self.request()[0], 503)

    def test_busy_worker_does_not_launch_another_model(self):
        with patch('serve.anime_python', return_value='python'), patch('serve.subprocess.run') as run:
            serve.INFERENCE_LOCK.acquire()
            try:
                self.assertEqual(self.request()[0], 429)
                run.assert_not_called()
            finally:
                serve.INFERENCE_LOCK.release()

    def test_success_and_failure_release_worker_lock(self):
        with patch('serve.anime_python', return_value='python'), patch('serve.subprocess.run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = b'{"width":10,"height":10,"faces":[]}'
            self.assertEqual(self.request()[0], 200)
            self.assertFalse(serve.INFERENCE_LOCK.locked())
            run.return_value.stdout = b'not json'
            self.assertEqual(self.request()[0], 503)
            self.assertFalse(serve.INFERENCE_LOCK.locked())


if __name__ == '__main__':
    unittest.main()
