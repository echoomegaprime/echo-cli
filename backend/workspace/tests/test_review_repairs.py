"""Request integrity, cancellation and model-tool review regressions."""
import http.client
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock

from app import Application, make_server
from accounts_http import WorkspaceAccounts
from workspace import WorkspaceError


class ReviewRepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Application(self.tmp.name, {'_tenant': True})
        self.chat = self.app.store.new_chat()
        self.app.model = Mock()
        self.app.model.generate.return_value = 'Four.'
        self.app.remember_context = Mock(return_value='')
        self.app.preferences.capture = Mock(return_value=None)
        self.body = {'chat_id': self.chat['id'], 'request_id': 'review-fixture', 'content': 'Two plus two?', 'model_provider': 'qwen'}

    def test_completed_request_rejects_changed_content_attachments_or_provider(self):
        self.app.chat(dict(self.body), lambda _: None)
        for change in ({'content': 'Different question'}, {'attachments': ['different-item']}, {'model_provider': 'gpt'}):
            with self.subTest(change=change), self.assertRaisesRegex(WorkspaceError, 'different'):
                self.app.chat({**self.body, **change}, lambda _: None)
        self.assertEqual(self.app.model.generate.call_count, 1)

    def test_fingerprint_survives_restart_and_matching_replay_does_not_infer(self):
        self.app.chat(dict(self.body), lambda _: None)
        restored = Application(self.tmp.name, {'_tenant': True})
        restored.model = Mock()
        events = []
        restored.chat(dict(self.body), events.append)
        restored.model.generate.assert_not_called()
        self.assertTrue(events[-1]['replayed'])
        with self.assertRaisesRegex(WorkspaceError, 'different'):
            restored.chat({**self.body, 'content': 'Changed after restart'}, events.append)

    def test_qwen_exception_preserves_failed_request_without_success_message(self):
        self.app.model.generate.side_effect = OSError('fixture unavailable')
        events = []
        with self.assertRaisesRegex(WorkspaceError, 'Qwen'):
            self.app.chat(dict(self.body), events.append)
        saved = self.app.store.chat(self.chat['id'])
        self.assertEqual([m['role'] for m in saved['messages']], ['user'])
        self.assertFalse(any(e['type'] == 'done' for e in events))
        failures = [json.loads(e['content']) for e in saved['events'] if e['kind'] == 'request_failed']
        self.assertEqual(failures[-1]['request_id'], self.body['request_id'])
        self.assertEqual(failures[-1]['provider'], 'qwen')
        with self.assertRaisesRegex(WorkspaceError, 'already|fresh'):
            self.app.chat(dict(self.body), events.append)
        self.assertEqual(self.app.model.generate.call_count, 1)

    def test_malformed_qwen_reply_cannot_be_saved_as_a_success(self):
        invalid = [
            ['unexpected response'], {'tool_calls': {'function': {}}},
            {'role': 'system', 'content': 'Wrong role'}, {'content': 42},
            {'tool_calls': [{'type': 'command', 'function': {'name': 'workspace', 'arguments': {'action': 'list_library'}}}]},
            {'tool_calls': [{'function': {'name': 'workspace', 'arguments': []}}]},
            {'tool_calls': [{'function': {'name': 'workspace', 'arguments': '{invalid-json'}}]},
            {'tool_calls': [{'function': {'name': 'not_available', 'arguments': {}}}]},
            {'content': ''},
            {'tool_calls': [{'function': {'name': 'workspace', 'arguments': {'action': 'list_library'}}}] * 5},
        ]
        for number, malformed in enumerate(invalid):
            with self.subTest(malformed=malformed):
                chat = self.app.store.new_chat()
                self.app.model.generate.side_effect = [malformed, 'A late explanation does not validate a malformed tool response.']
                events = []
                with self.assertRaisesRegex(WorkspaceError, 'Qwen'):
                    self.app.chat({**self.body, 'chat_id': chat['id'], 'request_id': 'malformed-' + str(number)}, events.append)
                saved = self.app.store.chat(chat['id'])
                self.assertEqual([m['role'] for m in saved['messages']], ['user'])
                self.assertTrue(any(event['kind'] == 'request_failed' for event in saved['events']))
                self.assertFalse(any(event['type'] == 'done' for event in events))
                self.assertEqual(self.app.model.generate.call_count, number + 1)

    def test_stop_between_tool_calls_preserves_first_receipt_and_skips_second(self):
        cancel = threading.Event()
        self.app.model.generate.return_value = {'tool_calls': [
            {'function': {'name': 'workspace', 'arguments': {'action': 'save_file', 'name': 'first.txt', 'content': 'First'}}},
            {'function': {'name': 'workspace', 'arguments': {'action': 'save_file', 'name': 'second.txt', 'content': 'Second'}}}]}
        def emit(event):
            if event['type'] == 'tool_result':
                cancel.set()
        with self.assertRaises(WorkspaceError):
            self.app.chat(dict(self.body), emit, cancel_event=cancel)
        self.assertEqual([f['name'] for f in self.app.store.library()], ['first.txt'])
        self.assertFalse(self.app.busy)
        self.assertEqual([m['role'] for m in self.app.store.chat(self.chat['id'])['messages']], ['user'])

    def test_pre_cancelled_request_never_calls_provider_or_tools(self):
        cancel = threading.Event(); cancel.set()
        with self.assertRaises(WorkspaceError):
            self.app.chat(dict(self.body), lambda _: None, cancel_event=cancel)
        self.app.model.generate.assert_not_called()

    def test_model_esh_is_not_advertised_and_cannot_dispatch_directly(self):
        self.app.config.pop('_tenant')
        self.app.bridges.call = Mock()
        self.assertNotIn('esh', {t['function']['name'] for t in self.app.tools.definitions()})
        with self.assertRaises(WorkspaceError):
            self.app.tools.execute('esh', {'command': 'fixture'}, self.chat['id'], 'model-esh')
        with self.assertRaisesRegex(WorkspaceError, 'review'):
            self.app.tools._execute('esh', {'command': 'fixture'}, self.chat['id'], 'model-esh')
        self.app.bridges.call.assert_not_called()

    def test_indirect_model_commands_require_review_before_any_dispatch(self):
        self.app.config.pop('_tenant')
        self.app.bridges.call = Mock()
        self.app.bridges.sdk = Mock()
        self.app.mcp.call = Mock()
        self.assertNotIn('node_execute', {t['function']['name'] for t in self.app.tools.definitions()})
        operations = [
            ('node_execute', {'node': 'quench', 'command': 'fixture'}),
            ('node_execute', {'node': 'forge', 'command': 'fixture'}),
            ('sdk_invoke', {'capability': 'echo.shell.run', 'command': 'run', 'options': {'cmd': 'fixture'}}),
            ('sdk_invoke', {'capability': 'echo.node.exec', 'command': 'exec', 'options': {'node': 'quench', 'command': 'fixture'}}),
            ('sdk_invoke', {'capability': 'echo.windows.command', 'command': 'run', 'options': {'command': 'fixture'}}),
            ('mcp_call', {'server_id': 'fixture', 'tool': 'execute_command', 'arguments': {'command': 'fixture'}}),
            ('mcp_call', {'server_id': 'fixture', 'tool': 'powershell', 'arguments': {'command': 'fixture'}}),
        ]
        for tool, arguments in operations:
            with self.subTest(tool=tool, arguments=arguments), self.assertRaisesRegex(WorkspaceError, 'review'):
                self.app.tools._execute(tool, arguments, self.chat['id'], 'indirect-command')
        self.app.bridges.call.assert_not_called()
        self.app.bridges.sdk.assert_not_called()
        self.app.mcp.call.assert_not_called()

    def test_model_mcp_routers_and_nested_command_selectors_require_review(self):
        self.app.mcp.call = Mock()
        payload = {'capability': 'echo.shell.run', 'command': 'run', 'options': {'cmd': 'fixture'}}
        calls = [(tool, payload) for tool in ('sdk_invoke', 'invoke', 'invoke_sdk_cap', 'call_tool', 'sdk')]
        calls += [('query_service', {'request': payload}),
                  ('query_service', {'payload': {'tool_name': 'node_execute', 'arguments': {'node': 'quench', 'command': 'fixture'}}}),
                  ('query_service', {'options': {'operation': 'powershell'}})]
        for tool, arguments in calls:
            with self.subTest(tool=tool, arguments=arguments), self.assertRaisesRegex(WorkspaceError, 'review'):
                self.app.tools._execute('mcp_call', {'server_id': 'fixture', 'tool': tool, 'arguments': arguments}, self.chat['id'], 'nested-command')
        self.app.mcp.call.assert_not_called()

    def test_command_review_preserves_plain_mcp_search_and_canonical_memory_save(self):
        self.app.mcp.call = Mock(return_value={'items': []})
        query = {'server_id': 'fixture', 'tool': 'search', 'arguments': {'query': 'Documentation explaining echo.shell.run'}}
        self.assertEqual(self.app.tools._execute('mcp_call', query, self.chat['id'], 'safe-search'), {'items': []})
        self.app.mcp.call.assert_called_once_with('fixture', 'search', query['arguments'])
        self.app.preferences.save = Mock(return_value={'saved': True, 'local_verified': True})
        self.assertTrue(self.app.tools._execute('remember', {'content': 'Use concise replies.'}, self.chat['id'], 'remember')['saved'])
        self.app.preferences.save.assert_called_once_with('Use concise replies.', self.chat['id'])

    def test_usage_is_bound_to_request_and_provider(self):
        self.app.model.last_usage = {'prompt_tokens': 10, 'context_length': 262144}
        self.app.model.last_identity = {'provider': 'qwen', 'model': 'fixture-model', 'reported': True}
        self.app.chat(dict(self.body), lambda _: None)
        usage = [json.loads(e['content']) for e in self.app.store.chat(self.chat['id'])['events'] if e['kind'] == 'model_usage'][-1]
        self.assertEqual(usage['request_id'], self.body['request_id'])
        self.assertEqual(usage['provider'], 'qwen')

    def test_logout_cancels_only_the_validated_session(self):
        self.app.config['auth'] = {'owner_uids': ['fixture']}
        accounts = WorkspaceAccounts(self.app)
        first, other = threading.Event(), threading.Event()
        token, csrf = 'fixture-session-token', 'fixture-session-csrf'
        key = accounts.accounts.key(token)
        accounts.accounts.sessions[key] = {'uid': 'fixture', 'csrf': csrf, 'expires': time.time() + 60}
        self.app.active_requests = {'first': {'session_key': key, 'cancel_event': first},
                                    'other': {'session_key': 'another-session', 'cancel_event': other}}
        accounts.cancel_session_requests(token, 'wrong-csrf')
        self.assertFalse(first.is_set())
        accounts.cancel_session_requests(token, csrf)
        self.assertTrue(first.is_set())
        self.assertFalse(other.is_set())
        with self.assertRaisesRegex(WorkspaceError, 'cancelled'):
            self.app.chat(dict(self.body), lambda _: None, session_key=key)
        self.app.model.generate.assert_not_called()

    def test_attachment_order_is_part_of_the_saved_request(self):
        first = self.app.store.library_add('one.txt', 'one')['id']
        second = self.app.store.library_add('two.txt', 'two')['id']
        self.app.chat({**self.body, 'attachments': [first, second]}, lambda _: None)
        with self.assertRaisesRegex(WorkspaceError, 'different'):
            self.app.chat({**self.body, 'attachments': [second, first]}, lambda _: None)
        self.assertEqual(self.app.model.generate.call_count, 1)


class DisconnectCancellationTests(unittest.TestCase):
    def cancel_auxiliary_inference(self, path, cancellation):
        from test_accounts import Provider
        with tempfile.TemporaryDirectory() as root:
            app = Application(root, {'auth': {'enabled': True, 'owner_uids': ['owner']}})
            chat = app.store.new_chat()
            for index in range(4):
                app.store.message(chat['id'], 'user' if index % 2 == 0 else 'assistant', 'Fixture ' + str(index), 'fixture-' + str(index))
            entered, cancelled = threading.Event(), threading.Event()
            def generate(*_, cancel_event=None, **__):
                entered.set()
                if cancel_event is not None and cancel_event.wait(3):
                    cancelled.set()
                    raise WorkspaceError('Qwen request cancelled.')
                return 'Late generated text'
            app.model = Mock(); app.model.generate.side_effect = generate
            server = make_server(app, 0)
            server.accounts.accounts.provider = Provider()
            token, _, csrf = server.accounts.accounts.login({'email': 'owner@example.test', 'password': 'valid-test-password'}, '127.0.0.1')
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=4)
            headers = {'Content-Type': 'application/json', 'X-Echo-CSRF': csrf,
                       'Origin': f'http://127.0.0.1:{server.server_port}', 'Cookie': 'echo_workspace_session=' + token}
            body = {'chat_id': chat['id']} if path == '/api/compact' else {'name': 'fixture.txt', 'content': 'Fixture review input'}
            try:
                connection.request('POST', path, json.dumps(body), headers)
                self.assertTrue(entered.wait(2))
                if cancellation == 'logout':
                    logout = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=4)
                    try:
                        logout.request('POST', '/api/auth/logout', '{}', headers)
                        reply = logout.getresponse(); reply.read()
                        self.assertEqual(reply.status, 200)
                    finally:
                        logout.close()
                else:
                    connection.close()
                self.assertTrue(cancelled.wait(2), path + ' must propagate cancellation to its model request.')
                end = time.monotonic() + 2
                while app.busy and time.monotonic() < end:
                    time.sleep(.01)
                self.assertFalse(app.busy)
                if path == '/api/compact':
                    saved = app.store.chat(chat['id'])
                    self.assertEqual(saved['summary'], '')
                    self.assertEqual(saved['cutoff'], 0)
                else:
                    review = next(item for item in app.store.chats() if item['source'] == 'code-review')
                    self.assertEqual([message['role'] for message in app.store.chat(review['id'])['messages']], ['user'])
            finally:
                connection.close(); server.shutdown(); server.server_close(); thread.join()

    def test_logout_cancels_compaction_and_code_review(self):
        for path in ('/api/compact', '/api/review'):
            with self.subTest(path=path):
                self.cancel_auxiliary_inference(path, 'logout')

    def test_disconnect_cancels_compaction_and_code_review(self):
        for path in ('/api/compact', '/api/review'):
            with self.subTest(path=path):
                self.cancel_auxiliary_inference(path, 'disconnect')

    def test_upstream_disconnect_cancels_inflight_provider_and_saves_no_reply(self):
        with tempfile.TemporaryDirectory() as root:
            app = Application(root, {'_tenant': True})
            app.remember_context = Mock(return_value='')
            app.preferences.capture = Mock(return_value=None)
            chat = app.store.new_chat()
            entered, cancelled = threading.Event(), threading.Event()
            def generate(*_, cancel_event=None, **__):
                entered.set()
                if cancel_event is not None and cancel_event.wait(3):
                    cancelled.set()
                    raise WorkspaceError('Qwen request cancelled.')
                return 'Late answer'
            app.model = Mock(); app.model.generate.side_effect = generate
            server = make_server(app, 0)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=4)
            try:
                body = {'chat_id': chat['id'], 'request_id': 'disconnect-fixture', 'content': 'Wait'}
                headers = {'Content-Type': 'application/json', 'X-Echo-CSRF': app.csrf,
                           'Origin': f'http://127.0.0.1:{server.server_port}'}
                connection.request('POST', '/api/chat', json.dumps(body), headers)
                response = connection.getresponse()
                self.assertTrue(entered.wait(2))
                response.close(); connection.close()
                self.assertTrue(cancelled.wait(2), 'A disconnected client must cancel the provider promptly.')
                end = time.monotonic() + 2
                while app.busy and time.monotonic() < end:
                    time.sleep(.01)
                self.assertFalse(app.busy)
                self.assertEqual([m['role'] for m in app.store.chat(chat['id'])['messages']], ['user'])
            finally:
                connection.close(); server.shutdown(); server.server_close(); thread.join()

    def test_logout_requires_valid_csrf_and_cancels_its_live_http_request(self):
        from test_accounts import Provider
        with tempfile.TemporaryDirectory() as root:
            app = Application(root, {'auth': {'enabled': True, 'owner_uids': ['owner']}})
            app.remember_context = Mock(return_value='')
            app.preferences.capture = Mock(return_value=None)
            chat = app.store.new_chat()
            entered, cancelled = threading.Event(), threading.Event()
            def generate(*_, cancel_event=None, **__):
                entered.set()
                if cancel_event is not None and cancel_event.wait(3):
                    cancelled.set()
                    raise WorkspaceError('Qwen request cancelled.')
                return 'Late answer'
            app.model = Mock(); app.model.generate.side_effect = generate
            server = make_server(app, 0)
            server.accounts.accounts.provider = Provider()
            token, _, csrf = server.accounts.accounts.login({'email': 'owner@example.test', 'password': 'valid-test-password'}, '127.0.0.1')
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=4)
            origin = f'http://127.0.0.1:{server.server_port}'
            headers = {'Content-Type': 'application/json', 'X-Echo-CSRF': csrf,
                       'Origin': origin, 'Cookie': 'echo_workspace_session=' + token}
            def logout(check):
                client = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=4)
                try:
                    client.request('POST', '/api/auth/logout', '{}', {**headers, 'X-Echo-CSRF': check})
                    reply = client.getresponse(); reply.read()
                    return reply.status
                finally:
                    client.close()
            try:
                connection.request('POST', '/api/chat', json.dumps({'chat_id': chat['id'], 'request_id': 'logout-fixture', 'content': 'Wait'}), headers)
                response = connection.getresponse()
                self.assertTrue(entered.wait(2))
                self.assertEqual(logout('wrong-csrf'), 403)
                self.assertFalse(cancelled.is_set())
                self.assertEqual(logout(csrf), 200)
                self.assertTrue(cancelled.wait(2))
                events = [json.loads(line) for line in response.read().decode().splitlines() if line.strip()]
                self.assertTrue(any(event['type'] == 'error' for event in events))
                self.assertFalse(any(event['type'] == 'done' for event in events))
                self.assertEqual([m['role'] for m in app.store.chat(chat['id'])['messages']], ['user'])
            finally:
                connection.close(); server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__':
    unittest.main()
