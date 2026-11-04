import json
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from adapters import Bridges, Model, SyncWorker, unpack
from workspace import Store


class AdapterTests(unittest.TestCase):
    def test_personality_structured_audio_receipt_takes_precedence_over_markdown(self):
        audio = {'status': 'first_chunk_ready', 'audio': {'provider': 'elevenlabs'}}
        self.assertEqual(unpack({'content': [{'type': 'text', 'text': '- status: first_chunk_ready'}],
                                 'structuredContent': audio}), audio)
    def test_model_context_drift_does_not_start_generation(self):
        model = Model('http://127.0.0.1:11439', 'fixture')
        response = {'models': [{'name': 'fixture', 'context_length': 32768}]}
        with patch('urllib.request.urlopen', return_value=io.StringIO(json.dumps(response))) as urlopen:
            with self.assertRaisesRegex(Exception, 'context'):
                model.generate([{'role': 'user', 'content': 'Hi'}])
            self.assertEqual(urlopen.call_count, 1)

    def test_second_loaded_model_is_not_accepted_as_exclusive(self):
        model = Model('http://127.0.0.1:11439', 'fixture')
        response = {'models': [{'name': 'fixture', 'context_length': 262144}, {'name': 'other'}]}
        with patch('urllib.request.urlopen', return_value=io.StringIO(json.dumps(response))):
            self.assertFalse(model.status()['ok'])

    def test_context_is_configurable_and_defaults_to_256k(self):
        model = Model('http://127.0.0.1:11439', 'fixture')
        self.assertEqual(model.context_length, 262144)
        with self.assertRaises(Exception):
            Model('http://127.0.0.1:11439', 'fixture', context_length=9999999)

    def test_256k_request_has_exact_budget_preflight_and_no_silent_truncation(self):
        model = Model('http://127.0.0.1:11439', 'fixture')
        responses = [io.StringIO('{"prompt_eval_count": 500}'),
                     io.BytesIO(b'{"message":{"content":"Hello"},"done":true,"prompt_eval_count":500}\n')]
        with patch.object(model, 'status', return_value={'loaded': True, 'ok': True}), patch('urllib.request.urlopen', side_effect=responses) as urlopen:
            self.assertEqual(model.generate([{'role': 'user', 'content': 'Hi'}]), 'Hello')
            for call in urlopen.call_args_list:
                body = json.loads(call.args[0].data)
                self.assertEqual(body['options']['num_ctx'], 262144)
                self.assertFalse(body['truncate'])
                self.assertFalse(body['shift'])

    def test_overfull_model_prompt_is_rejected_before_generation(self):
        model = Model('http://127.0.0.1:11439', 'fixture')
        with patch.object(model, 'status', return_value={'loaded': True, 'ok': True}), patch('urllib.request.urlopen', return_value=io.StringIO('{"prompt_eval_count":262000}')) as urlopen:
            with self.assertRaisesRegex(Exception, 'Compact'):
                model.generate([{'role': 'user', 'content': 'Hi'}])
            self.assertEqual(urlopen.call_count, 1)

    def test_nested_denial_is_not_success(self):
        with self.assertRaisesRegex(Exception, 'scope_forbidden'):
            unpack({'ok': True, 'result': {'body': {'ok': False, 'error': 'scope_forbidden'}}})

    def test_missing_scope_does_not_spawn_vault_or_sdk(self):
        with patch.dict('os.environ', {}, clear=True), patch('subprocess.run') as run:
            bridge = Bridges({})
            with self.assertRaisesRegex(Exception, 'mission scope'):
                bridge.sdk('echo.vault.health', 'health', {})
            run.assert_not_called()

    def test_vault_secrets_stay_off_argv_and_return_payload(self):
        result = {'result': {'body': {'stored': True, 'service': 'test', 'version': 1, 'secret': 'never-return-this'}}}
        with patch.dict('os.environ', {'SOL_BROKER_TOKEN': 'fixture', 'SOL_STATE_DB': 'fixture'}):
            with patch('subprocess.run') as run:
                run.return_value.returncode = 0
                run.return_value.stdout = json.dumps(result)
                run.return_value.stderr = ''
                b = Bridges({'python': 'python', 'sol_cli': 'sol_cli.py'})
                returned = b.vault('put', {'service': 'test', 'username': 'fixture', 'secret': 'never-return-this'})
                self.assertNotIn('never-return-this', json.dumps(returned))
                args = run.call_args.args[0]
                self.assertNotIn('never-return-this', str(args))
                self.assertIn('--options-file', args)
                self.assertIn('never-return-this', run.call_args.kwargs['input'])

    def test_node_shell_command_is_nested_without_overriding_broker_verb(self):
        with patch.dict('os.environ', {'SOL_BROKER_TOKEN': 'fixture', 'SOL_STATE_DB': 'fixture'}), patch('subprocess.run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = '{"ok":true,"stdout":"crucible"}'
            bridge = Bridges({'sol_cli': 'sol_cli.py'})
            bridge.sdk('echo.node.exec', 'exec', {'node': 'crucible', 'command': 'hostname', 'timeout': 15})
            options = json.loads(run.call_args.kwargs['input'])
            self.assertNotIn('command', options)
            self.assertEqual(options['options']['command'], 'hostname')
            self.assertEqual(options['options']['node'], 'crucible')

    def test_sync_keeps_pending_on_denial_and_verifies_exact_record(self):
        with tempfile.TemporaryDirectory() as temp:
            s = Store(Path(temp))
            s.new_chat()
            class Fake:
                denied = True
                captured = None
                def call(self, plugin, tool, args):
                    if self.denied:
                        raise RuntimeError('No SOL mission scope')
                    if tool == 'continuity_capture':
                        self.captured = args
                        return {'ok': True}
                    return {'ok': True, 'events': [{'id': 'evt_confirmed', 'content_text': self.captured['title'] + '\n' + self.captured['detail']}] if self.captured else []}
            b = Fake()
            w = SyncWorker(s, b)
            w.once()
            self.assertEqual(s.sync_status()['verified'], 0)
            self.assertEqual(s.sync_status()['blocked'], 1)
            b.denied = False
            s.delivery(s.pending()[0]['id'], 'retry', 'Scope restored')
            w.once()
            self.assertEqual(s.sync_status()['verified'], 1)

    def test_sync_never_reposts_written_record_during_readback_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            s = Store(Path(temp))
            s.new_chat()
            job = s.pending()[0]
            s.delivery(job['id'], 'written', 'accepted')
            class Fake:
                def call(self, plugin, tool, args):
                    if tool == 'continuity_capture':
                        raise AssertionError('must not write again')
                    return {'ok': True, 'events': []}
            SyncWorker(s, Fake()).once()
            self.assertEqual(s.pending()[0]['state'], 'written')


if __name__ == '__main__':
    unittest.main()
