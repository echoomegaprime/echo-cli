"""Offline deployment boundary tests; no application, SSH, or model starts."""
import importlib.util
import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path

spec = importlib.util.spec_from_file_location('prime_runtime', Path(__file__).with_name('prime_runtime.py'))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class DeploymentTests(unittest.TestCase):
    def test_sdk_startup_requires_own_normal_live_mission_and_token_hash_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = self.settings(root)
            data = root / 'data'
            data.mkdir()
            settings['workspace_config'].update(sol_cli=str(root / 'sol.py'), python=settings['executables']['python'],
                mission={'enabled': True, 'state': str(root / 'sol.db'), 'workspace': str(root / 'owner-workspace'),
                         'owner_session': 'fixture-owner-session', 'role': 'builder'})
            identity = data / 'sol-mission.json'
            identity.write_text(json.dumps({'run_id': 'sol-fixture', 'role': 'builder', 'token_hash': 'c' * 64}), encoding='utf-8')
            live = {'run_id': 'sol-fixture', 'role': 'builder', 'workspace': str(root / 'owner-workspace'),
                    'status': 'running', 'pause_requested': False, 'halt_requested': False}
            def result(value): return SimpleNamespace(returncode=0, stdout=json.dumps(value), stderr='')
            with patch.object(runtime.subprocess, 'run', return_value=result(live)) as invoke:
                runtime.verify_scoped_mission(settings)
                argv = invoke.call_args.args[0]
                self.assertEqual(argv[-3:], ['mission', 'show', 'sol-fixture'])
                self.assertNotIn('SOL_BROKER_TOKEN', invoke.call_args.kwargs['env'])
            for change in ({'role': 'commander'}, {'workspace': str(root / 'other')}, {'status': 'complete'},
                           {'pause_requested': True}, {'halt_requested': True}, {'run_id': 'other'}):
                with self.subTest(change=list(change)), patch.object(runtime.subprocess, 'run', return_value=result({**live, **change})):
                    with self.assertRaises(ValueError): runtime.verify_scoped_mission(settings)
            identity.write_text(json.dumps({'run_id': 'sol-fixture', 'role': 'builder'}), encoding='utf-8')
            with self.assertRaises(ValueError): runtime.verify_scoped_mission(settings)

    def test_source_binding_rejects_mixed_reviewed_receipts(self):
        runtime.validate_source_binding({'source_sha': 'a' * 40}, {'source_sha': 'a' * 40}, {'source_sha': 'a' * 40})
        with self.assertRaises(ValueError):
            runtime.validate_source_binding({'source_sha': 'b' * 40}, {'source_sha': 'a' * 40}, {'source_sha': 'b' * 40})
        with self.assertRaises(ValueError):
            runtime.validate_source_binding({'source_sha': 'a' * 40}, {'source_sha': 'a' * 40}, {'source_sha': 'b' * 40})

    def test_runtime_identity_uses_os_token_and_refuses_environment_spoof_or_lookup_failure(self):
        with patch.dict(runtime.os.environ, {'USERDOMAIN': 'QUENCH', 'USERNAME': 'approved'}):
            with patch.object(runtime, 'windows_identity', return_value='QUENCH\\actual'):
                with self.assertRaises(ValueError):
                    runtime.validate_runtime_identity('QUENCH\\approved')
            with patch.object(runtime.ctypes, 'WinDLL', side_effect=OSError('fixture OS lookup failure'), create=True):
                with self.assertRaises(OSError):
                    runtime.windows_identity()

    def settings(self, root):
        return {'schema_version': 1, 'source_sha': 'a' * 40,
                'release_root': str(root / 'release'), 'data_root': str(root / 'data'),
                'windows_user': 'QUENCH\\fixture', 'public_origin': 'https://echoomegaprime.com',
                'ports': {'workspace': 18768, 'prime': 18769, 'qwen_tunnel': 11451,
                          'forge_forward': 18770, 'forge_proxy': 18771},
                'executables': {'python': str(root / 'python.exe'), 'node': str(root / 'node.exe'), 'ssh': str(root / 'ssh.exe')},
                'ssh': {'host': '100.113.87.107', 'user': 'forge', 'identity_file': str(root / 'existing-key'),
                        'known_hosts_file': str(root / 'known_hosts'), 'qwen_remote_port': 11441},
                'workspace_config': {'auth': {'enabled': True, 'issuer': 'https://auth.echo-op.com',
                                              'owner_uids': ['verified-fixture'], 'legacy_data_owner_uid': 'verified-fixture',
                                              'trusted_proxy_ips': ['127.0.0.1']},
                                     'model': 'c3po-code:echo-qwen38-abliterated-256k', 'context_length': 262144},
                'prime_config': {'workspace': {'ownerUid': 'verified-fixture'}, 'trustedIngressProxyIps': ['127.0.0.1']}}

    def test_rejects_protected_ports_unsafe_origins_unpinned_owner_and_untrusted_ingress(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for modify in [lambda v: v['ports'].update(prime=8781),
                           lambda v: v.update(public_origin='http://echoomegaprime.com'),
                           lambda v: v['prime_config'].update(trustedIngressProxyIps=[]),
                           lambda v: v['workspace_config']['auth'].update(enabled=False),
                           lambda v: v['workspace_config']['auth'].update(legacy_data_owner_uid='unverified'),
                           lambda v: v['ssh'].update(host='forge-alias'),
                           lambda v: v['workspace_config'].update(api_key='must-never-stage')]:
                value = self.settings(root)
                modify(value)
                with self.subTest(settings=list(value)), self.assertRaises(ValueError):
                    runtime.validate_settings(value)

    def test_launch_plan_uses_argument_arrays_loopback_exact_origin_and_existing_ssh_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            value = runtime.validate_settings(self.settings(root))
            plan = runtime.launch_plan(value, root / 'stage')
            self.assertEqual(set(plan), {'workspace', 'prime', 'ssh'})
            self.assertTrue(all(isinstance(command, list) for command in plan.values()))
            self.assertIn('--port', plan['workspace'])
            self.assertIn('18768', plan['workspace'])
            self.assertIn('BatchMode=yes', plan['ssh'])
            self.assertIn('StrictHostKeyChecking=yes', plan['ssh'])
            self.assertIn('ExitOnForwardFailure=yes', plan['ssh'])
            self.assertIn('127.0.0.1:18770:127.0.0.1:18769', plan['ssh'])
            self.assertIn('127.0.0.1:11451:127.0.0.1:11441', plan['ssh'])
            self.assertEqual(plan['ssh'][-1], 'forge@100.113.87.107')
            self.assertFalse(any('0.0.0.0' in argument for command in plan.values() for argument in command))

    def test_forge_proxy_is_domain_specific_streaming_bounded_and_keeps_backend_private(self):
        with tempfile.TemporaryDirectory() as folder:
            value = runtime.validate_settings(self.settings(Path(folder)))
            proxy = runtime.forge_proxy(value)
            self.assertIn('listen 127.0.0.1:18771', proxy)
            self.assertIn('proxy_pass http://127.0.0.1:18770', proxy)
            self.assertNotIn(':18768', proxy)
            self.assertIn('return 308 https://echoomegaprime.com$request_uri', proxy)
            self.assertIn('proxy_set_header Host echoomegaprime.com', proxy)
            self.assertIn('proxy_set_header X-Forwarded-For ""', proxy)
            self.assertIn('proxy_set_header CF-Connecting-IP $http_cf_connecting_ip', proxy)
            self.assertIn('proxy_buffering off', proxy)
            self.assertIn('proxy_read_timeout 620s', proxy)

    def test_artifact_manifest_rejects_traversal_missing_required_file_and_changed_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in runtime.REQUIRED_ARTIFACTS:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(name, encoding='utf-8')
            manifest = runtime.artifact_manifest(root, 'a' * 40)
            runtime.verify_artifact(root, manifest)
            injected = root / 'backend' / 'workspace' / 'unreviewed_module.py'
            injected.write_text('not reviewed', encoding='utf-8')
            with self.assertRaises(ValueError):
                runtime.verify_artifact(root, manifest)
            injected.unlink()
            damaged = json.loads(json.dumps(manifest))
            damaged['files'][0]['path'] = '../outside'
            with self.assertRaises(ValueError):
                runtime.verify_artifact(root, damaged)
            damaged = json.loads(json.dumps(manifest))
            damaged['files'] = damaged['files'][1:]
            with self.assertRaises(ValueError):
                runtime.verify_artifact(root, damaged)
            (root / runtime.REQUIRED_ARTIFACTS[0]).write_text('changed', encoding='utf-8')
            with self.assertRaises(ValueError):
                runtime.verify_artifact(root, manifest)

    def test_task_definition_is_windowless_same_user_and_pinned_without_installing(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = runtime.validate_settings(self.settings(root))
            release, stage = root / 'release', root / 'stage'
            stage.mkdir()
            for name in runtime.REQUIRED_ARTIFACTS:
                path = release / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(name, encoding='utf-8')
            (root / 'pythonw.exe').touch()
            for name, content in [('settings.json', settings), ('artifact-manifest.json', runtime.artifact_manifest(release, 'a' * 40))]:
                (stage / name).write_text(json.dumps(content), encoding='utf-8')
            admission = root / 'admission.json'
            admission.write_text(json.dumps({'source_sha': 'a' * 40}), encoding='utf-8')
            output = stage / 'task.xml'
            runtime.prepare_task(stage, runtime.sha256(stage / 'artifact-manifest.json'), runtime.sha256(stage / 'settings.json'),
                                 admission, runtime.sha256(admission), output)
            task = ET.parse(output)
            ns = {'t': 'http://schemas.microsoft.com/windows/2004/02/mit/task'}
            self.assertEqual(task.findtext('.//t:Command', namespaces=ns), str(root / 'pythonw.exe'))
            self.assertEqual(task.findtext('.//t:LogonType', namespaces=ns), 'InteractiveToken')
            self.assertEqual(task.findtext('.//t:RunLevel', namespaces=ns), 'LeastPrivilege')
            self.assertEqual(task.findtext('.//t:Hidden', namespaces=ns), 'true')
            self.assertIsNone(task.find('.//t:Password', namespaces=ns))
            self.assertIsNone(task.find('.//t:RestartOnFailure', namespaces=ns))
            arguments = task.findtext('.//t:Arguments', namespaces=ns)
            self.assertIn(runtime.sha256(admission), arguments)
            self.assertIn(runtime.sha256(stage / 'artifact-manifest.json'), arguments)
            self.assertIn('prime_runtimew.pyw', arguments)


if __name__ == '__main__':
    unittest.main()
