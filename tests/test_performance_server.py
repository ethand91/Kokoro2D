"""Local performance API and optional repair adapter; no model dependencies."""
import base64
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import serve

class PerformanceEndpointTests(unittest.TestCase):
    def request(self, path, payload=None, method='POST', headers=None):
        body=json.dumps(payload).encode()
        handler=object.__new__(serve.NoStoreHandler)
        handler.path=path
        handler.headers={'Content-Type':'application/json','Content-Length':str(len(body)),'Host':'127.0.0.1:5173',**(headers or {})}
        handler.rfile=io.BytesIO(body)
        replies=[]
        handler.reply=lambda status,result: replies.append((status,result))
        getattr(handler,'do_'+method)()
        return replies[0]

    def test_commands_are_ordered_and_cursor_skips_consumed_commands(self):
        first=self.request('/api/control',{'type':'parameters','values':{'head.yaw':.4}})
        self.assertEqual(first[0],200)
        second=self.request('/api/control',{'type':'reset'})
        self.assertGreater(second[1]['sequence'],first[1]['sequence'])
        status,result=self.request('/api/control?after='+str(first[1]['sequence']),method='GET')
        self.assertEqual(status,200)
        self.assertEqual([event['command'] for event in result['events']],[{'type':'reset'}])

    def test_rejects_cross_origin_and_invalid_commands(self):
        self.assertEqual(self.request('/api/control',{'type':'reset'},headers={'Origin':'https://example.com'})[0],403)
        self.assertEqual(self.request('/api/control',{'type':'shell'})[0],400)
        self.assertEqual(self.request('/api/control',{'type':'reset'},headers={'Content-Type':'text/plain'})[0],415)
        self.assertEqual(self.request('/api/control?after=bad',method='GET')[0],400)

    def test_unconfigured_repair_is_explicit_and_never_launches_a_process(self):
        with patch.dict('serve.os.environ',{},clear=True), patch('serve.subprocess.run') as run:
            self.assertFalse(self.request('/api/reconstruct',method='GET')[1]['available'])
            self.assertEqual(self.request('/api/reconstruct',{})[0],503)
            run.assert_not_called()

    def test_repair_helper_receives_only_image_and_mask_and_releases_lock(self):
        png='data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\nfixture').decode()
        with patch.dict('serve.os.environ',{'KOKORO_RECONSTRUCT_COMMAND':'python3 local-repair.py'}),patch('serve.subprocess.run') as run:
            run.return_value.returncode=0
            run.return_value.stdout=json.dumps({'image':png}).encode()
            status,result=self.request('/api/reconstruct',{'image':png,'mask':png,'command':'ignored'})
            self.assertEqual(status,200)
            self.assertEqual(result,{'image':png})
            self.assertEqual(run.call_args.args[0],['python3','local-repair.py'])
            self.assertEqual(set(json.loads(run.call_args.kwargs['input'])),{'image','mask'})
            self.assertFalse(serve.INFERENCE_LOCK.locked())
            run.return_value.stdout=b'not json'
            self.assertEqual(self.request('/api/reconstruct',{'image':png,'mask':png})[0],503)
            self.assertFalse(serve.INFERENCE_LOCK.locked())

if __name__=='__main__':
    unittest.main()
