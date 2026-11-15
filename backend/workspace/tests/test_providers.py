import json
import sys
import threading
import time
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app import Application
from providers import CliProvider, ProviderRouter, ProviderUnavailableError, child_environment
from workspace import WorkspaceError


def completed(value, code=0):
    return SimpleNamespace(returncode=code, stdout=value, stderr='', timed_out=False)


class ProviderTests(unittest.TestCase):
    def test_grok_hook_metadata_classifies_only_well_formed_native_pretool_commands(self):
        from pathlib import Path
        from providers import grok_isolation_snapshot
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            home = root / '.grok'
            home.mkdir()
            path = home / 'config.toml'
            env = {'HOME': folder, 'USERPROFILE': folder, 'GROK_HOME': str(home)}
            valid = '[[hooks.PreToolUse]]\nmatcher=".*"\n[[hooks.PreToolUse.hooks]]\ntype="command"\ncommand="fixture-only"\ntimeout=3\n'
            path.write_text(valid, encoding='utf-8')
            snapshot = grok_isolation_snapshot(directory=folder, environment=env)
            self.assertTrue(snapshot['native_pretool_only'])
            self.assertEqual(snapshot['native_hook_events'], ['PreToolUse'])
            for content in [valid.replace('PreToolUse', 'Stop'), valid.replace('type="command"', 'type="http"'),
                            '[[hooks.PreToolUse]]\nhooks=[]\n', valid + '[hooks.SessionStart]\nunexpected=true\n']:
                path.write_text(content, encoding='utf-8')
                self.assertFalse(grok_isolation_snapshot(directory=folder, environment=env)['native_pretool_only'])
            path.write_text(valid, encoding='utf-8')
            (home / 'hooks').mkdir()
            (home / 'hooks' / 'uncovered.json').write_text('{}', encoding='utf-8')
            self.assertFalse(grok_isolation_snapshot(directory=folder, environment=env)['native_pretool_only'])

    def test_grok_pretool_exception_requires_bound_native_branch_evidence_and_current_binary(self):
        import hashlib
        from pathlib import Path
        from providers import _grok_review
        h = lambda data: hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            binary = root / 'grok.exe'
            binary.write_bytes(b'synthetic-native-binary')
            binary.chmod(0o700)
            proof_root = root / 'proof'
            proof_root.mkdir()
            files = {
                'positive/stderr.txt': '2026-11-04T19:03:31.757555Z  WARN gate hook failed; ignoring (fail-open) hook_name=user:pre_tool_use[0].hooks[0] elapsed_ms=622 hook_failure=exit code 1: At line:1 char:32\n',
                'isolated/stderr.txt': '2026-11-04T19:03:33.733879Z ERROR tool_error: parse_failure session_id=fixture tool_name="read_file" error_message=Tool not found: read_file\n',
                'positive/stdout.ndjson': json.dumps({'type': 'available_commands', 'tools': ['read_file']}) + '\n',
                'isolated/stdout.ndjson': json.dumps({'type': 'available_commands', 'tools': []}) + '\n',
                'positive/.grok/config.toml': 'synthetic configured PreToolUse fixture',
                'isolated/.grok/config.toml': 'synthetic configured PreToolUse fixture',
                'positive/work/answer-model.md': 'synthetic positive profile',
                'isolated/work/answer-model.md': 'synthetic isolated profile',
            }
            original = {'installed_grok_sha256': h(binary.read_bytes()), 'harness_sha256': h(b'fixture-harness'),
                        'synthetic_only': True, 'oauth_read_or_copied': False,
                        'provider_subscription_acceptance': False, 'release_acceptance': False,
                        'results': [{'case': 'positive', 'returncode': 0, 'abort': None, 'local_model_requests': 2},
                                    {'case': 'isolated', 'returncode': 0, 'abort': None, 'local_model_requests': 2,
                                     'empty_advertised_catalog': True, 'tool_not_found_observed': True, 'hook_marker': False}]}
            files['receipt.json'] = json.dumps(original)
            for name, content in files.items():
                path = proof_root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding='utf-8')
            (proof_root / 'harness.py').write_bytes(b'fixture-harness')
            recipe = {'tools': 'read_file', 'disallowed_tools': 'read_file,search_tool,use_tool',
                      'no_subagents': True, 'no_plan': True, 'disable_web_search': True, 'deny': 'MCPTool',
                      'permission_mode': 'dontAsk', 'agent_profile': 'injectDefaultTools:false; tools:[read_file]; disallowedTools:[search_tool,use_tool]; mcpInheritance:none',
                      'native_hooks': 'PreToolUse fixture remains configured in both cases'}
            evidence = {'schema_version': 1, 'kind': 'native_pretool_branch_reachability',
                        'installed_grok_sha256': original['installed_grok_sha256'], 'harness_sha256': original['harness_sha256'],
                        'isolation_recipe': recipe, 'synthetic_only': True, 'oauth_read_or_copied': False,
                        'provider_subscription_acceptance': False, 'release_acceptance': False,
                        'files': [{'path': name, 'sha256': h((proof_root / name).read_bytes())} for name in files]}
            proof = proof_root / 'branch-proof.json'
            proof.write_text(json.dumps(evidence), encoding='utf-8')
            config = {'command': str(binary), 'grok_isolation': {'sha256': 'a' * 64},
                      'native_pretool_isolation': {'receipt_path': str(proof), 'receipt_sha256': h(proof.read_bytes())}}
            snapshot = {'sha256': 'a' * 64, 'mcp_servers': [], 'plugins': [], 'unsupported_source_count': 0,
                        'native_hook_count': 1, 'native_pretool_only': True, 'native_hook_events': ['PreToolUse'], 'inventory': []}
            with patch('providers.grok_isolation_snapshot', return_value=snapshot):
                self.assertEqual(_grok_review(config)['sha256'], 'a' * 64)
                for bad in ({**config, 'native_pretool_isolation': None},
                            {**config, 'native_pretool_isolation': {**config['native_pretool_isolation'], 'receipt_sha256': '0' * 64}}):
                    with self.assertRaises(ProviderUnavailableError): _grok_review(bad)
                binary.write_bytes(b'changed-native-binary')
                with self.assertRaises(ProviderUnavailableError): _grok_review(config)
                binary.write_bytes(b'synthetic-native-binary')
            for changed in ({'native_hook_events': ['Stop']}, {'native_pretool_only': False},
                            {'inventory': [{'kind': 'native_hook', 'path': 'unreviewed-hook-file'}]}):
                with patch('providers.grok_isolation_snapshot', return_value={**snapshot, **changed}):
                    with self.assertRaises(ProviderUnavailableError): _grok_review(config)
            # Updating an operator's claimed result/hash cannot hide actual
            # negative native dispatch: derive the decision from bound traces.
            negative = proof_root / 'isolated' / 'stderr.txt'
            negative.write_text(negative.read_text() + files['positive/stderr.txt'], encoding='utf-8')
            for row in evidence['files']:
                if row['path'] == 'isolated/stderr.txt': row['sha256'] = h(negative.read_bytes())
            proof.write_text(json.dumps(evidence), encoding='utf-8')
            config['native_pretool_isolation']['receipt_sha256'] = h(proof.read_bytes())
            with patch('providers.grok_isolation_snapshot', return_value=snapshot):
                with self.assertRaises(ProviderUnavailableError): _grok_review(config)

    def test_grok_native_catalog_uses_recognized_nonempty_allowlist_then_explicitly_denies_it(self):
        # Installed Grok1.0.62 treats an empty --tools argument as defaults.
        # A clean home must not admit that broad native catalog either.
        snapshot = {'sha256': 'a' * 64, 'mcp_servers': [], 'plugins': [],
                    'native_hook_count': 0, 'unsupported_source_count': 0}
        with tempfile.TemporaryDirectory() as root, patch('providers.grok_isolation_snapshot', return_value=snapshot):
            argv = CliProvider('grok', {'grok_isolation': {'sha256': 'a' * 64}})._arguments(root)
            allow = argv[argv.index('--tools') + 1]
            deny = set(argv[argv.index('--disallowed-tools') + 1].split(','))
            self.assertEqual(allow, 'read_file')
            self.assertTrue({'read_file', 'search_tool', 'use_tool'}.issubset(deny))

    def test_grok_requires_current_isolation_before_spawn_and_is_hidden_until_admitted(self):
        safe = {'sha256': 'a' * 64, 'mcp_servers': ['native'], 'plugins': ['native-plugin'], 'native_hook_count': 0,
                'unsupported_source_count': 0}
        settings = {'grok_isolation': {'sha256': 'a' * 64}}
        for config, snapshot in [({}, safe), (settings, {**safe, 'sha256': 'b' * 64}),
                                 (settings, {**safe, 'native_hook_count': 1}),
                                 (settings, {**safe, 'unsupported_source_count': 1})]:
            runner = Mock(return_value=completed('{"text":"unsafe"}'))
            with patch('providers.grok_isolation_snapshot', return_value=snapshot, create=True):
                with self.assertRaisesRegex(ProviderUnavailableError, 'Grok.*isolation'):
                    CliProvider('grok', config, runner=runner).generate([{'role': 'user', 'content': 'hello'}])
                rows = ProviderRouter({'model_providers': {'grok': config}}).choices()
            runner.assert_not_called()
            self.assertNotIn('grok', [row['id'] for row in rows])
        with patch('providers.grok_isolation_snapshot', return_value=safe):
            rows = ProviderRouter({'model_providers': {'grok': settings}}).choices()
        self.assertIn('grok', [row['id'] for row in rows])

    def test_grok_uses_own_profile_and_project_disables_without_relocating_login(self):
        from pathlib import Path
        import tomllib
        safe = {'sha256': 'a' * 64, 'mcp_servers': ['native.with.dot'], 'plugins': ['user/hash/plugin'],
                'native_hook_count': 0, 'unsupported_source_count': 0}
        captured = {}
        def invoke(argv, **options):
            captured.update(argv=argv, env=options['env'])
            root = Path(options['cwd'])
            captured['config'] = tomllib.loads((root / '.grok' / 'config.toml').read_text(encoding='utf-8'))
            captured['profile'] = (root / 'answer-model.md').read_text(encoding='utf-8')
            self.assertTrue((root / 'prompt.txt').is_file())
            self.assertEqual(argv[argv.index('--agent') + 1], str(root / 'answer-model.md'))
            self.assertIn(str(root), argv[argv.index('--leader-socket') + 1])
            return completed('{"text":"answer"}')
        with patch('providers.grok_isolation_snapshot', return_value=safe, create=True), patch.dict(
                'os.environ', {'GROK_HOME': str(Path(tempfile.gettempdir()) / 'own-existing-login'),
                               'GROK_CONFIG': '{"hooks":"must not inherit"}'}, clear=False):
            model = CliProvider('grok', {'grok_isolation': {'sha256': 'a' * 64}}, runner=invoke)
            self.assertEqual(model.generate([{'role': 'user', 'content': 'hello'}]), 'answer')
        self.assertEqual(captured['config']['mcp_servers'], {'native.with.dot': {'enabled': False, 'command': 'echo-prime-disabled'}})
        self.assertEqual(captured['config']['plugins']['disabled'], ['user/hash/plugin'])
        self.assertEqual(captured['env']['GROK_HOME'], str(Path(tempfile.gettempdir()) / 'own-existing-login'))
        for vendor in ('CLAUDE', 'CURSOR', 'CODEX'):
            for surface in ('MCPS', 'HOOKS', 'SKILLS', 'RULES', 'AGENTS', 'SESSIONS'):
                self.assertEqual(captured['env'][f'GROK_{vendor}_{surface}_ENABLED'], '0')
        for key in ('GROK_MEMORY', 'GROK_SUBAGENTS', 'GROK_MANAGED_MCPS_ENABLED',
                    'GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED', 'GROK_SESSION_SEARCH', 'GROK_SESSION_RECAP'):
            self.assertEqual(captured['env'][key], '0')
        self.assertEqual(json.loads(captured['env']['GROK_CONFIG'])['features']['managed_config'], False)
        self.assertEqual(captured['argv'][captured['argv'].index('--disallowed-tools') + 1], 'read_file,search_tool,use_tool')
        self.assertEqual(captured['argv'][captured['argv'].index('--deny') + 1], 'MCPTool')
        self.assertEqual(captured['argv'][captured['argv'].index('--permission-mode') + 1], 'dontAsk')
        for line in ('promptMode: full', 'agentsMd: false', 'discoverSkills: false', 'injectDefaultTools: false'):
            self.assertIn(line, captured['profile'])

    def test_grok_snapshot_hashes_only_native_configuration_and_detects_hook_and_policy_drift(self):
        from pathlib import Path
        from providers import grok_isolation_snapshot
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / 'own-grok'
            home.mkdir()
            (home / 'config.toml').write_text('[mcp_servers.native]\nurl="https://fixture.invalid"\nheaders={Authorization="private"}\n[plugins]\nenabled=["plugin-one"]\n', encoding='utf-8')
            (home / 'auth.json').write_text('must-not-read-this', encoding='utf-8')
            claude = Path(directory) / '.claude'
            claude.mkdir()
            (claude / 'settings.json').write_text('{"enabledPlugins":{"compat-plugin@market":true},"env":{"PRIVATE":"never-export"}}', encoding='utf-8')
            environment = {'GROK_HOME': str(home), 'HOME': directory, 'USERPROFILE': directory}
            with patch.dict('os.environ', environment, clear=True):
                snapshot = grok_isolation_snapshot(directory=directory)
            self.assertEqual(snapshot['mcp_servers'], ['native'])
            self.assertEqual(snapshot['plugins'], ['compat-plugin', 'plugin-one'])
            self.assertEqual(snapshot['native_hook_count'], 0)
            self.assertEqual(snapshot['unsupported_source_count'], 0)
            self.assertNotIn('private', json.dumps(snapshot))
            self.assertNotIn('auth.json', json.dumps(snapshot))
            self.assertNotIn('never-export', json.dumps(snapshot))
            (home / 'hooks').mkdir()
            (home / 'hooks' / 'personal.json').write_text('{"command":"must-not-read"}', encoding='utf-8')
            with patch.dict('os.environ', environment, clear=True):
                changed = grok_isolation_snapshot(directory=directory)
            self.assertEqual(changed['native_hook_count'], 1)
            self.assertNotEqual(snapshot['sha256'], changed['sha256'])
            (home / 'requirements.toml').write_text('[memory_v2]\nenabled=true\n', encoding='utf-8')
            with patch.dict('os.environ', environment, clear=True):
                pinned = grok_isolation_snapshot(directory=directory)
            self.assertGreater(pinned['unsupported_source_count'], 0)

    def test_codex_mcp_override_is_one_toml_map_preserving_existing_transports(self):
        import tomllib
        names = ['server.with.dot', 'server/with/slash', 'server-with-dash']
        settings = {'disabled_mcp_servers': names + ['stale-name'], 'codex_isolation': {'sha256': 'a' * 64}}
        result = '\n'.join(json.dumps(event) for event in [
            {'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'answer'}}, {'type': 'turn.completed'}])
        runner = Mock(return_value=completed(result))
        with patch('providers.codex_isolation_snapshot', return_value={'sha256': 'a' * 64, 'mcp_servers': names}):
            CliProvider('gpt', settings, runner=runner).generate([{'role': 'user', 'content': 'hello'}])
        arguments = runner.call_args.args[0]
        maps = [argument for argument in arguments if argument.startswith('mcp_servers=')]
        self.assertEqual(len(maps), 1)
        servers = tomllib.loads(maps[0])['mcp_servers']
        self.assertEqual(set(servers), set(names))
        self.assertTrue(all(row == {'enabled': False} for row in servers.values()))
        original = {names[0]: {'url': 'https://fixture.invalid/mcp'}, names[1]: {'command': 'fixture.exe'},
                    names[2]: {'url': 'https://another.invalid/mcp', 'enabled': True}}
        merged = {name: {**row, **servers[name]} for name, row in original.items()}
        self.assertEqual(merged[names[0]], {'url': 'https://fixture.invalid/mcp', 'enabled': False})
        self.assertEqual(merged[names[1]], {'command': 'fixture.exe', 'enabled': False})
        self.assertFalse(any('url' in row and 'command' in row for row in merged.values()))
        self.assertFalse(any(argument.startswith('mcp_servers.') for argument in arguments))

    def test_gpt_rejects_config_drift_and_uncovered_mcp_before_child_spawn(self):
        settings = {'disabled_mcp_servers': ['one'], 'codex_isolation': {'sha256': 'a' * 64}}
        for snapshot in [{'sha256': 'b' * 64, 'mcp_servers': ['one']},
                         {'sha256': 'a' * 64, 'mcp_servers': ['one', 'new-server']}]:
            runner = Mock(return_value=completed('{}'))
            with patch('providers.codex_isolation_snapshot', return_value=snapshot, create=True):
                with self.assertRaisesRegex(ProviderUnavailableError, 'isolation'):
                    CliProvider('gpt', settings, runner=runner).generate([{'role': 'user', 'content': 'hello'}])
            runner.assert_not_called()

    def test_codex_snapshot_contains_only_config_hashes_and_mcp_names_never_auth_material(self):
        from pathlib import Path
        from providers import codex_isolation_snapshot
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            (path / 'config.toml').write_text('[mcp_servers.one]\ncommand="safe"\n[mcp_servers.one.env]\nAPI_KEY="do-not-extract"\n', encoding='utf-8')
            (path / 'auth.json').write_text('must-never-read-this', encoding='utf-8')
            snapshot = codex_isolation_snapshot(directory=root, environment={'CODEX_HOME': root, 'HOME': root})
            self.assertIn('one', snapshot['mcp_servers'])
            self.assertEqual(len(snapshot['sha256']), 64)
            self.assertNotIn('do-not-extract', json.dumps(snapshot))
            self.assertNotIn('auth.json', json.dumps(snapshot))
            old = snapshot['sha256']
            (path / 'extra.config.toml').write_text('[mcp_servers.two]\ncommand="safe"\n', encoding='utf-8')
            changed = codex_isolation_snapshot(directory=root, environment={'CODEX_HOME': root, 'HOME': root})
            self.assertNotEqual(old, changed['sha256'])
            self.assertIn('two', changed['mcp_servers'])

    def test_cancelled_request_never_spawns_an_official_cli(self):
        import providers
        cancelled = threading.Event()
        cancelled.set()
        runner = Mock()
        with self.assertRaisesRegex(WorkspaceError, 'cancel'):
            CliProvider('claude', {}, runner=runner).generate([{'role': 'user', 'content': 'hello'}], cancel_event=cancelled)
        runner.assert_not_called()

    def test_running_child_is_cancelled_promptly_without_using_a_model(self):
        from providers import _run
        with tempfile.TemporaryDirectory() as root:
            cancelled = threading.Event()
            timer = threading.Timer(0.2, cancelled.set)
            started = time.monotonic()
            timer.start()
            try:
                result = _run([sys.executable, '-c', 'import time; time.sleep(20)'], cwd=root, env=child_environment(),
                              input='', timeout=20, max_bytes=1000, cancel_event=cancelled)
            finally:
                timer.cancel()
            self.assertTrue(result.cancelled)
            self.assertFalse(result.timed_out)
            self.assertLess(time.monotonic() - started, 5)

    def test_qwen_budget_is_shared_across_tenant_instances_and_cancellation_precedes_transport(self):
        from adapters import Model
        first = Model('http://127.0.0.1:11439', 'fixture')
        second = Model('http://localhost:11439', 'fixture')
        first.lock.acquire()
        try:
            with patch('urllib.request.urlopen') as opening:
                with self.assertRaisesRegex(ProviderUnavailableError, 'Qwen.*another'):
                    second.generate([{'role': 'user', 'content': 'hello'}])
                opening.assert_not_called()
        finally:
            first.lock.release()
        cancelled = threading.Event()
        cancelled.set()
        with patch('urllib.request.urlopen') as opening:
            with self.assertRaisesRegex(WorkspaceError, 'cancel'):
                second.generate([{'role': 'user', 'content': 'hello'}], cancel_event=cancelled)
            opening.assert_not_called()

    def test_qwen_http_cancellation_disconnects_only_its_owned_request(self):
        from adapters import _qwen_open
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        entered, opened, released, cancelled = threading.Event(), threading.Event(), threading.Event(), threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.flush()
                entered.set()
                released.wait(5)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        # Cancel only after urllib has handed the response to the caller and
        # closed/detached its original connection wrapper. Cancelling as soon as
        # the server flushes headers races this ownership transition.
        canceller = threading.Thread(target=lambda: (opened.wait(2), cancelled.set()), daemon=True)
        canceller.start()
        started = time.monotonic()
        timeline = []
        def record(stage):
            timeline.append({'stage': stage, 'elapsed_ms': round((time.monotonic() - started) * 1000)})
        try:
            with patch('adapters._model_log.debug', side_effect=lambda message: timeline.append(json.loads(message))):
                with self.assertRaisesRegex(WorkspaceError, 'cancel'):
                    with _qwen_open(f'http://127.0.0.1:{server.server_address[1]}/fixture', 20, cancelled) as response:
                        record('client_entered')
                        opened.set()
                        record('body_read_begin')
                        response.read()
                        record('body_read_returned')
            self.assertLess(time.monotonic() - started, 3, json.dumps(timeline))
        finally:
            released.set()
            server.shutdown()
            server.server_close()
            canceller.join(timeout=2)
            worker.join(timeout=2)

    def test_qwen_unavailable_context_and_incomplete_errors_are_named_no_fallback(self):
        import io
        from adapters import Model
        model = Model('http://127.0.0.1:11439', 'fixture')
        with patch.object(model, 'status', return_value={'ok': False, 'error': 'not loaded'}):
            with self.assertRaisesRegex(ProviderUnavailableError, 'Qwen.*no fallback'):
                model.generate([{'role': 'user', 'content': 'hello'}])
        for responses in [[io.StringIO('{"prompt_eval_count":262000}')],
                          [io.StringIO('{"prompt_eval_count":5}'), io.BytesIO(b'{"message":{"content":"partial"}}\n')]]:
            with patch.object(model, 'status', return_value={'ok': True}), patch('urllib.request.urlopen', side_effect=responses):
                with self.assertRaisesRegex(ProviderUnavailableError, 'Qwen.*no fallback'):
                    model.generate([{'role': 'user', 'content': 'hello'}])

    def test_qwen_malformed_or_unconfigured_tools_fail_before_canonical_dispatch(self):
        import io
        from adapters import Model
        model = Model('http://127.0.0.1:11439', 'fixture')
        tools = [{'type': 'function', 'function': {'name': 'workspace', 'parameters': {'type': 'object'}}}]
        valid = {'function': {'name': 'workspace', 'arguments': {'action': 'read_chat', 'id': 'known'}}}
        messages = [
            {'content': {'invalid': True}}, {'content': 'answer', 'tool_calls': {'invalid': True}},
            {'content': '', 'tool_calls': [None]}, {'content': '', 'tool_calls': [{'function': {'name': 'shell', 'arguments': {}}}]},
            {'content': '', 'tool_calls': [{'function': {'name': 'workspace', 'arguments': []}}]},
            {'content': '', 'tool_calls': [valid] * 5}, {'content': '', 'tool_calls': [{**valid, 'type': 'shell'}]},
            {'role': 'system', 'content': 'wrong role'},
        ]
        for message in messages:
            with self.subTest(message=message):
                responses = [io.StringIO('{"prompt_eval_count":5}'), io.StringIO(json.dumps({'done': True, 'message': message}))]
                with patch.object(model, 'status', return_value={'ok': True}), patch('urllib.request.urlopen', side_effect=responses):
                    with self.assertRaisesRegex(ProviderUnavailableError, 'Qwen.*no fallback'):
                        model.generate([{'role': 'user', 'content': 'hello'}], tools=tools)

    def test_qwen_valid_canonical_tool_call_with_json_arguments_is_normalized_as_data(self):
        import io
        from adapters import Model
        model = Model('http://127.0.0.1:11439', 'fixture')
        tools = [{'type': 'function', 'function': {'name': 'workspace', 'parameters': {'type': 'object'}}}]
        result = {'done': True, 'message': {'content': '', 'tool_calls': [{'function': {'name': 'workspace', 'arguments': '{"action":"read_chat","id":"known"}'}}]}}
        responses = [io.StringIO('{"prompt_eval_count":5}'), io.StringIO(json.dumps(result))]
        with patch.object(model, 'status', return_value={'ok': True}), patch('urllib.request.urlopen', side_effect=responses):
            answer = model.generate([{'role': 'user', 'content': 'hello'}], tools=tools)
        self.assertEqual(answer['tool_calls'][0]['function']['arguments'], {'action': 'read_chat', 'id': 'known'})

    def test_environment_has_profile_paths_but_no_inherited_credentials(self):
        result = child_environment({'PATH': 'bin', 'USERPROFILE': 'profile', 'APPDATA': 'app',
                                    'OPENAI_API_KEY': 'secret', 'SOL_BROKER_TOKEN': 'secret', 'ANTHROPIC_API_KEY': 'secret'})
        self.assertEqual(result, {'PATH': 'bin', 'USERPROFILE': 'profile', 'APPDATA': 'app'})

    def test_official_clis_run_in_empty_directory_with_tools_disabled_and_report_identity(self):
        cases = [
            ('claude', json.dumps({'is_error': False, 'result': 'four', 'modelUsage': {'claude-reported': {'outputTokens': 2}}}), 'claude-reported'),
            ('grok', json.dumps({'text': 'four', 'modelUsage': {'grok-reported': {'outputTokens': 2}}}), 'grok-reported'),
            ('gpt', '\n'.join(json.dumps(row) for row in [
                {'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'four'}}, {'type': 'turn.completed'}]), None)
        ]
        for provider, output, reported in cases:
            with self.subTest(provider=provider):
                runner = Mock(return_value=completed(output))
                model = CliProvider(provider, {'model': 'reviewed-model', 'disabled_mcp_servers': ['one'],
                                               'codex_isolation': {'sha256': 'a' * 64},
                                               'grok_isolation': {'sha256': 'a' * 64}}, runner=runner)
                with patch('providers.codex_isolation_snapshot', return_value={'sha256': 'a' * 64, 'mcp_servers': ['one']}), patch(
                        'providers.grok_isolation_snapshot', return_value={'sha256': 'a' * 64, 'mcp_servers': ['one'],
                                                                         'plugins': [], 'native_hook_count': 0, 'unsupported_source_count': 0}):
                    self.assertEqual(model.generate([{'role': 'user', 'content': 'two plus two'}]), 'four')
                argv, options = runner.call_args.args[0], runner.call_args.kwargs
                self.assertFalse(options.get('shell', False))
                if provider == 'grok':
                    self.assertIn('--prompt-file', argv)
                else:
                    self.assertIn('two plus two', options['input'])
                self.assertNotIn('API_KEY', ' '.join(options['env']))
                self.assertEqual(model.last_identity, {'provider': provider, 'requested': 'reviewed-model', 'model': reported, 'reported': reported is not None})
                if provider == 'gpt':
                    self.assertIn('features.shell_tool=false', argv)
                    self.assertIn('features.plugins=false', argv)
                    self.assertIn('mcp_servers={"one"={enabled=false}}', argv)
                    self.assertIn('developer_instructions=""', argv)
                    self.assertIn('memories.use_memories=false', argv)
                    self.assertIn('memories.generate_memories=false', argv)
                    self.assertTrue(any(argument.startswith('model_instructions_file=') and 'model-instructions.md' in argument for argument in argv))
                    for feature in ('browser_use_external', 'browser_use_full_cdp_access', 'remote_plugin',
                                    'in_app_local_automation', 'code_mode_host_grpc', 'js_repl', 'apply_patch_freeform',
                                    'memories', 'external_agent_memory_import', 'guardian_conversation_history_tools', 'analytics_plan_history'):
                        self.assertIn('features.' + feature + '=false', argv)
                else:
                    self.assertIn('--tools', argv)
                if provider == 'grok':
                    self.assertTrue(all(flag in argv for flag in ('--no-subagents', '--no-plan', '--disable-web-search')))
                if provider == 'claude':
                    self.assertIn('--safe-mode', argv)
                    self.assertIn('--restricted', argv)
                    self.assertEqual(options['env']['CLAUDE_CODE_DISABLE_ATTACHMENTS'], '1')
                    self.assertEqual(options['env']['CLAUDE_CODE_DISABLE_CLAUDE_MDS'], '1')

    def test_canonical_tools_are_returned_as_data_and_arbitrary_cli_tools_are_refused(self):
        tool = {'type': 'function', 'function': {'name': 'workspace', 'parameters': {'type': 'object'}}}
        answer = {'content': '', 'tool_calls': [{'function': {'name': 'workspace', 'arguments': {'action': 'read_chat', 'id': 'known'}}}]}
        runner = Mock(return_value=completed(json.dumps({'is_error': False, 'result': json.dumps(answer)})))
        model = CliProvider('claude', {}, runner=runner)
        self.assertEqual(model.generate([{'role': 'user', 'content': 'read it'}], tools=[tool]), answer)
        answer['tool_calls'][0]['function']['name'] = 'shell'
        runner.return_value = completed(json.dumps({'is_error': False, 'result': json.dumps(answer)}))
        with self.assertRaisesRegex(ProviderUnavailableError, 'no fallback'):
            model.generate([{'role': 'user', 'content': 'read it'}], tools=[tool])

    def test_nonzero_timeout_failed_turn_and_missing_codex_isolation_fail_without_retry(self):
        for result in [completed('{}', 1), SimpleNamespace(returncode=None, stdout='', stderr='', timed_out=True),
                       completed(json.dumps({'is_error': True, 'result': 'authentication unavailable'}))]:
            runner = Mock(return_value=result)
            with self.assertRaisesRegex(ProviderUnavailableError, 'Claude.*no fallback'):
                CliProvider('claude', {}, runner=runner).generate([{'role': 'user', 'content': 'hello'}])
            self.assertEqual(runner.call_count, 1)
        runner = Mock()
        with self.assertRaisesRegex(ProviderUnavailableError, 'isolation'):
            CliProvider('gpt', {}, runner=runner).generate([{'role': 'user', 'content': 'hello'}])
        runner.assert_not_called()

    def test_router_keeps_qwen_default_and_uses_fresh_request_scoped_models_with_shared_admission(self):
        from adapters import Model
        router = ProviderRouter({'model_providers': {'claude': {'model': 'sonnet'}, 'gpt': {'disabled_mcp_servers': []}}})
        qwen = Model('http://127.0.0.1:11439', 'fixture')
        first, second = router.select(None, qwen), router.select('qwen', qwen)
        self.assertIsNot(first, qwen)
        self.assertIsNot(second, first)
        self.assertIs(first.lock, second.lock)
        self.assertEqual(first.base, qwen.base)
        self.assertEqual(first.model, qwen.model)
        first.last_usage = {'provider': 'qwen', 'prompt_tokens': 12}
        second.last_usage = {'provider': 'qwen', 'prompt_tokens': 400}
        self.assertEqual(first.last_usage['prompt_tokens'], 12)
        self.assertEqual(qwen.last_usage, {})
        self.assertIsNot(router.select('claude', qwen), router.select('claude', qwen))
        self.assertEqual([row['id'] for row in router.choices()], ['qwen', 'claude', 'gpt'])
        with self.assertRaisesRegex(WorkspaceError, 'not configured'):
            router.select('grok', qwen)

    def test_codex_failed_or_native_tool_events_are_not_accepted_as_model_answers(self):
        for extra in [{'type': 'turn.failed'}, {'type': 'item.completed', 'item': {'type': 'command_execution', 'command': 'refused'}}]:
            events = [{'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'answer'}}, extra, {'type': 'turn.completed'}]
            runner = Mock(return_value=completed('\n'.join(json.dumps(event) for event in events)))
            with patch('providers.codex_isolation_snapshot', return_value={'sha256': 'a' * 64, 'mcp_servers': ['one']}):
                with self.assertRaisesRegex(ProviderUnavailableError, 'no fallback'):
                    CliProvider('gpt', {'disabled_mcp_servers': ['one'], 'codex_isolation': {'sha256': 'a' * 64}}, runner=runner).generate([{'role': 'user', 'content': 'hello'}])
            self.assertEqual(runner.call_count, 1)

    def test_real_child_transport_bounds_output_and_deadline_without_a_model_call(self):
        from providers import _run
        with tempfile.TemporaryDirectory() as root:
            result = _run([sys.executable, '-c', 'print("x" * 10000)'], cwd=root, env=child_environment(),
                          input='', timeout=10, max_bytes=1000)
            self.assertTrue(result.timed_out)
            self.assertLessEqual(len(result.stdout), 1000)
            result = _run([sys.executable, '-c', 'import time; time.sleep(20)'], cwd=root, env=child_environment(),
                          input='', timeout=0.1, max_bytes=1000)
            self.assertTrue(result.timed_out)
            self.assertNotEqual(result.returncode, 0)

    def test_child_budget_is_shared_between_tenants_and_providers(self):
        import providers
        providers._child_lock.acquire()
        try:
            runner = Mock()
            with self.assertRaisesRegex(ProviderUnavailableError, 'another provider'):
                CliProvider('claude', {}, runner=runner).generate([{'role': 'user', 'content': 'hello'}])
            runner.assert_not_called()
        finally:
            providers._child_lock.release()


class SavedChatProviderTests(unittest.TestCase):
    def test_selected_provider_uses_canonical_storage_journal_and_replay_without_changing_default(self):
        with tempfile.TemporaryDirectory() as root:
            app = Application(root, {'model_providers': {'claude': {'model': 'sonnet'}}})
            qwen = app.model
            selected = Mock()
            selected.generate.return_value = {'content': 'A plain answer.'}
            selected.last_usage = {}
            selected.last_identity = {'provider': 'claude', 'requested': 'sonnet', 'model': 'claude-reported', 'reported': True}
            chat = app.store.new_chat()
            body = {'chat_id': chat['id'], 'request_id': 'same-send', 'content': 'Hello', 'model_provider': 'claude'}
            events = []
            with patch.object(app.models, 'select', return_value=selected) as choose:
                app.chat(dict(body), events.append)
                app.chat(dict(body), events.append)
            choose.assert_called_with('claude', qwen)
            self.assertIs(app.model, qwen)
            self.assertEqual(selected.generate.call_count, 1)
            readback = app.store.chat(chat['id'])
            self.assertEqual(len(readback['messages']), 2)
            identity = [json.loads(event['content']) for event in readback['events'] if event['kind'] == 'model_identity']
            self.assertEqual(identity, [{'request_id': 'same-send', **selected.last_identity}])
            self.assertTrue(events[-1]['replayed'])
            self.assertTrue((app.store.root / 'journals' / (chat['id'] + '.md')).is_file())

    def test_provider_failure_is_named_and_never_saved_as_a_successful_assistant_reply(self):
        with tempfile.TemporaryDirectory() as root:
            app = Application(root, {'model_providers': {'claude': {}}})
            selected = Mock()
            selected.generate.side_effect = ProviderUnavailableError('claude', 'not signed in')
            chat = app.store.new_chat()
            with patch.object(app.models, 'select', return_value=selected):
                with self.assertRaisesRegex(ProviderUnavailableError, 'Claude.*no fallback'):
                    app.chat({'chat_id': chat['id'], 'request_id': 'failed-send', 'content': 'Hello', 'model_provider': 'claude'}, lambda _: None)
            self.assertEqual([row['role'] for row in app.store.chat(chat['id'])['messages']], ['user'])
            self.assertNotIn(chat['id'], app.busy)

    def test_unknown_provider_is_rejected_before_user_message_or_inference(self):
        with tempfile.TemporaryDirectory() as root:
            app = Application(root, {})
            chat = app.store.new_chat()
            with self.assertRaisesRegex(WorkspaceError, 'not configured'):
                app.chat({'chat_id': chat['id'], 'request_id': 'invalid', 'content': 'Hello', 'model_provider': 'grok'}, lambda _: None)
            self.assertEqual(app.store.chat(chat['id'])['messages'], [])


if __name__ == '__main__':
    unittest.main()
