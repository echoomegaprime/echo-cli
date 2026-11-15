import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch
from app import Application, make_server


class FakeModel:
    def status(self):
        return {'ok': True, 'model': 'fixture', 'loaded': True}
    def generate(self, messages, on_token=None, max_tokens=2048, tools=None, cancel_event=None):
        if on_token:
            on_token('A saved reply.')
        return 'A saved reply.'


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = Application(self.temp.name, {})
        self.app.model = FakeModel()
        self.server = make_server(self.app, 0)
        self.base = f'http://127.0.0.1:{self.server.server_address[1]}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def post(self, path, body, **headers):
        headers.setdefault('X-Echo-CSRF', self.app.csrf)
        headers.setdefault('Content-Type', 'application/json')
        request = urllib.request.Request(self.base + path, json.dumps(body).encode(), headers, method='POST')
        return urllib.request.urlopen(request, timeout=10)

    def test_missing_csrf_and_foreign_origin_are_rejected(self):
        for headers in [{'X-Echo-CSRF': ''}, {'Origin': 'https://unrelated.invalid'}]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.post('/api/chats', {}, **headers)
            self.assertEqual(error.exception.code, 403)
            error.exception.close()
        self.assertEqual(self.app.store.chats(), [])

    def test_host_rebinding_is_rejected(self):
        request = urllib.request.Request(self.base + '/api/state', headers={'Host': 'evil.invalid'})
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request)
        self.assertEqual(error.exception.code, 403)
        error.exception.close()

    def test_chat_stream_saves_reply_once_and_has_journal(self):
        with self.post('/api/chats', {'title': 'HTTP chat'}) as response:
            c = json.load(response)
        body = {'chat_id': c['id'], 'content': 'Hello', 'request_id': 'request1', 'use_memory': False}
        for _ in range(2):
            with self.post('/api/chat', body) as response:
                events = [json.loads(line) for line in response if line.strip()]
                self.assertEqual(events[-1]['type'], 'done')
        chat = self.app.store.chat(c['id'])
        self.assertEqual(len(chat['messages']), 2)
        self.assertIn('A saved reply', Path(chat['journal_path']).read_text(encoding='utf-8'))

    def test_static_paths_cannot_escape_and_model_output_is_text(self):
        with urllib.request.urlopen(self.base + '/') as response:
            self.assertIn('Content-Security-Policy', response.headers)
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.base + '/../../workspace.py')
        self.assertEqual(error.exception.code, 404)
        error.exception.close()

    def test_sdk_cannot_smuggle_vault_secrets(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.post('/api/action', {'action': 'sdk', 'capability': 'echo.vault.put', 'command': 'put', 'options': {'secret': 'fixture'}})
        self.assertEqual(error.exception.code, 400)
        error.exception.close()

    def test_secret_is_redacted_before_external_recall(self):
        c = self.app.store.new_chat()
        secret = 'sk-' + 'z' * 40
        with patch.object(self.app, 'remember_context', return_value='') as recall:
            self.app.chat({'chat_id': c['id'], 'content': 'api_key=' + secret,
                          'request_id': 'sensitive', 'use_memory': True, 'echo_memory': True}, lambda _: None)
            self.assertNotIn(secret, recall.call_args.args[0])

    def test_sdk_supports_registered_non_echo_namespace(self):
        with patch.dict('os.environ', {'SOL_BROKER_TOKEN': 'fixture', 'SOL_STATE_DB': 'fixture'}):
            self.app.bridges.config.update({'sol_cli': 'sol_cli.py'})
            with patch('subprocess.run') as run:
                run.return_value.returncode = 0
                run.return_value.stdout = '{"ok":true}'
                self.assertTrue(self.app.bridges.sdk('claude.shadowglass.status', 'status', {})['ok'])


if __name__ == '__main__':
    unittest.main()
