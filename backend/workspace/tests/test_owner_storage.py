"""Real temporary HTTP boundaries, offline verified identities, no production data."""
import copy
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from app import Application, make_server
from accounts import Accounts, AuthError
import test_auth_http as http_helpers
from test_current_admission import CurrentProvider


PRIMARY = '3oLmdCQ0llZgSkkM47DS0ThEp9q1'
SECONDARY = 'secondary-owner-verified-test'


class OwnerStorageHttpTests(unittest.TestCase):
    request = http_helpers.HttpIsolationTests.request
    login = http_helpers.HttpIsolationTests.login

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = {'auth': {'enabled': True, 'owner_uids': [PRIMARY, SECONDARY],
                                'legacy_data_owner_uid': PRIMARY},
                       'plugins': {'ecf': {'command': 'must-never-run'}},
                       'agents_paths': ['private-owner-instructions'],
                       'voice': {'persona': 'private-owner-voice'},
                       'model_url': 'http://127.0.0.1:9', 'model': 'offline-test'}
        self.start()

    def start(self):
        self.owner = Application(self.root / 'owner', copy.deepcopy(self.config))
        self.server = make_server(self.owner, 0)
        self.provider = CurrentProvider()
        self.server.accounts.accounts.provider = self.provider
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)

    def tearDown(self):
        self.stop()
        self.tmp.cleanup()

    def test_two_owners_separate_storage_without_losing_account_admin(self):
        history = self.owner.store.new_chat('PRIMARY_PRIVATE_HISTORY')
        library = self.owner.store.library_add('private.txt', 'PRIMARY_PRIVATE_FILE', history['id'])
        self.owner.preferences.save('PRIMARY_PRIVATE_PREFERENCE', history['id'])
        primary, pc, _ = self.login(PRIMARY)
        secondary, sc, user = self.login(SECONDARY)
        self.assertEqual(user['role'], 'owner')
        self.assertEqual(self.request('GET', '/api/chats/' + history['id'], cookie=primary)[0], 200)
        for path in ('/api/chats/' + history['id'], '/api/journals/' + history['id'], '/api/library/' + library['id']):
            code, body, _ = self.request('GET', path, cookie=secondary)
            self.assertEqual(code, 404, path)
            self.assertNotIn('PRIMARY_PRIVATE', str(body))
        code, state, _ = self.request('GET', '/api/state', cookie=secondary)
        self.assertEqual(code, 200)
        self.assertEqual(state['user']['role'], 'owner')
        self.assertTrue(state['tenant_isolation'])
        self.assertEqual(state['preferences'], [])
        self.assertIsNone(state['data_path'])
        private = self.server.accounts.application(user)
        self.assertEqual(private.store.root, self.owner.store.root / 'users' / Accounts.key(SECONDARY))
        self.assertNotIn('plugins', private.config)
        self.assertNotIn('auth', private.config)
        self.assertNotIn('voice', private.config)
        self.assertNotIn('agents_paths', private.config)
        self.assertFalse(private.mission.options.get('enabled'))
        for path in ('/api/diagnostics', '/api/plugins', '/api/catalog', '/api/fleet'):
            self.assertEqual(self.request('GET', path, cookie=secondary)[0], 403, path)
        self.assertEqual(self.request('POST', '/api/sync', {}, secondary, sc)[0], 403)
        for action in ('sdk', 'sdk_detail', 'esh', 'vault', 'crystal_save', 'memory_search', 'personality_assets'):
            with patch.object(self.owner.bridges, 'call', side_effect=AssertionError('owner connector reached')), \
                 patch.object(self.owner.bridges, 'sdk', side_effect=AssertionError('owner SDK reached')), \
                 patch.object(self.owner.bridges, 'vault', side_effect=AssertionError('owner vault reached')):
                self.assertEqual(self.request('POST', '/api/action', {'action': action}, secondary, sc)[0], 403, action)
        _, _, pending = self.login('member')
        self.assertEqual(pending['status'], 'pending')
        self.assertEqual(self.request('GET', '/api/auth/accounts', cookie=secondary)[0], 200)
        for decision, expected in (('approve', 'approved'), ('deny', 'denied')):
            code, value, _ = self.request('POST', '/api/auth/decide', {'uid': 'member', 'decision': decision}, secondary, sc)
            self.assertEqual(code, 200)
            self.assertEqual(value['user']['status'], expected)
        self.assertEqual(self.owner.store.chat(history['id'])['title'], 'PRIMARY_PRIVATE_HISTORY')

    def test_secondary_private_mcp_preferences_and_cross_id_writes(self):
        from test_remote_mcp import Cipher, Transport
        primary, pc, _ = self.login(PRIMARY)
        secondary, sc, user = self.login(SECONDARY)
        for app in (self.owner, self.server.accounts.application(user)):
            app.mcp.cipher, app.mcp.transport = Cipher(), Transport
        code, row, _ = self.request('POST', '/api/mcp', {'action': 'add', 'name': 'primary',
                            'url': 'https://example.com/mcp', 'auth': 'bearer', 'token': 'offline-primary-credential'}, primary, pc)
        self.assertEqual(code, 200)
        self.assertEqual(self.request('GET', '/api/mcp', cookie=secondary)[1]['connections'], [])
        self.assertEqual(self.request('GET', '/api/mcp/tools/' + row['id'], cookie=secondary)[0], 404)
        self.assertEqual(self.request('POST', '/api/mcp', {'action': 'remove', 'id': row['id']}, secondary, sc)[0], 400)
        _, chat, _ = self.request('POST', '/api/chats', {'title': 'SECONDARY_PRIVATE'}, secondary, sc)
        self.assertEqual(self.request('GET', '/api/chats/' + chat['id'], cookie=primary)[0], 404)
        self.assertEqual(self.request('POST', '/api/action', {'action': 'memory_save', 'content': 'PRIVATE',
                                                            'chat_id': chat['id']}, primary, pc)[0], 400)
        self.assertEqual(self.request('POST', '/api/chats', {'title': 'csrf'}, secondary, pc)[0], 403)

    def test_private_root_is_stable_after_restart_and_client_hints_do_not_select_it(self):
        secondary, sc, user = self.login(SECONDARY)
        _, chat, _ = self.request('POST', '/api/chats', {'title': 'SECONDARY_DURABLE', 'uid': PRIMARY,
                                  'role': 'owner', 'tenant': Accounts.key(PRIMARY)}, secondary, sc)
        before = self.server.accounts.application(user).store.root
        self.assertNotEqual(before, self.owner.store.root)
        self.stop()
        self.start()
        secondary, _, user = self.login(SECONDARY)
        self.assertEqual(self.server.accounts.application(user).store.root, before)
        self.assertEqual(self.request('GET', '/api/chats/' + chat['id'], cookie=secondary)[0], 200)
        primary, _, _ = self.login(PRIMARY)
        self.assertEqual(self.request('GET', '/api/chats/' + chat['id'], cookie=primary)[0], 404)

    def test_invalid_multi_owner_mapping_fails_private_selection_but_preserves_admin(self):
        for mapping in (None, '', 'not-pinned', [], 42):
            with self.subTest(mapping=mapping):
                self.stop()
                if mapping is None:
                    self.config['auth'].pop('legacy_data_owner_uid', None)
                else:
                    self.config['auth']['legacy_data_owner_uid'] = mapping
                self.start()
                private = self.owner.store.new_chat('MUST_NOT_LEAK')
                for name in (PRIMARY, SECONDARY):
                    cookie, csrf, user = self.login(name)
                    self.assertEqual(user['role'], 'owner')
                    for path in ('/api/chats', '/api/chats/' + private['id'], '/api/state'):
                        code, value, _ = self.request('GET', path, cookie=cookie)
                        self.assertEqual(code, 503, path)
                        self.assertNotIn('MUST_NOT_LEAK', str(value))
                        self.assertNotIn(PRIMARY, str(value))
                    self.assertEqual(self.request('GET', '/api/auth/accounts', cookie=cookie)[0], 200)
                self.assertEqual(self.request('GET', '/privacy')[0], 200)
                self.assertEqual(self.request('GET', '/login')[0], 200)
                self.assertEqual(self.server.accounts.apps, {})

    def test_single_owner_absent_mapping_retains_existing_history(self):
        self.stop()
        self.config['auth'] = {'enabled': True, 'owner_uids': [PRIMARY]}
        self.start()
        chat = self.owner.store.new_chat('SINGLE_OWNER_LEGACY')
        cookie, _, user = self.login(PRIMARY)
        self.assertIs(self.server.accounts.application(user), self.owner)
        self.assertEqual(self.request('GET', '/api/chats/' + chat['id'], cookie=cookie)[0], 200)

    def test_each_protected_http_request_checks_current_canonical_state(self):
        cookie, csrf, _ = self.login(SECONDARY)
        before = self.provider.calls
        for path in ('/', '/app.js', '/api/chats', '/api/state', '/api/auth/session', '/api/auth/accounts'):
            self.assertEqual(self.request('GET', path, cookie=cookie)[0], 200, path)
        self.assertEqual(self.request('POST', '/api/chats', {'title': 'verified'}, cookie, csrf)[0], 200)
        self.assertEqual(self.provider.calls - before, 7)
        self.provider.failure = AuthError('raw issuer driver detail', 503)
        code, value, _ = self.request('GET', '/api/chats', cookie=cookie)
        self.assertEqual(code, 503)
        self.assertNotIn('raw issuer', str(value))
        for path in ('/login', '/privacy', '/auth.js', '/auth.css'):
            self.assertEqual(self.request('GET', path, cookie=cookie)[0], 200)
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=8)
        try:
            conn.request('GET', '/echo-icon.png', headers={'Cookie': cookie})
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertTrue(response.read().startswith(b'\x89PNG'))
        finally:
            conn.close()
        self.provider.failure = None
        self.assertEqual(self.request('GET', '/api/chats', cookie=cookie)[0], 200)
        self.provider.failure = AuthError('disabled', 401)
        self.assertEqual(self.request('GET', '/api/chats', cookie=cookie)[0], 401)
        self.provider.failure = None
        self.assertEqual(self.request('GET', '/api/chats', cookie=cookie)[0], 401)

    def test_outage_logout_revokes_cookie_without_current_verifier_or_provider_success(self):
        cookie, csrf, _ = self.login(SECONDARY)
        before = self.provider.calls
        self.provider.failure = AuthError('private issuer outage', 503)
        with patch.object(self.provider, 'logout', side_effect=OSError('private logout driver detail')):
            code, value, cleared = self.request('POST', '/api/auth/logout', {}, cookie, csrf)
        self.assertEqual(code, 200)
        self.assertEqual(value, {'ok': True})
        self.assertIn('Max-Age=0', cleared)
        self.assertEqual(self.provider.calls, before)
        self.assertEqual(self.server.accounts.accounts.sessions, {})
        self.provider.failure = None
        self.assertEqual(self.request('GET', '/api/chats', cookie=cookie)[0], 401)
        self.assertEqual(self.request('GET', '/api/auth/session', cookie=cookie)[1]['authenticated'], False)
        rows = [json.loads(line) for line in self.server.accounts.accounts.audit.read_text().splitlines()]
        logout = [row for row in rows if row['operation'] == 'logout']
        self.assertEqual(logout[-1]['status'], 'revoked')
        self.assertEqual(set(logout[-1]), {'observed_at_utc', 'operation', 'status'})

    def test_outage_logout_wrong_origin_or_csrf_does_not_revoke(self):
        cookie, csrf, _ = self.login(SECONDARY)
        self.provider.failure = AuthError('private issuer outage', 503)
        before = self.provider.calls
        with patch.object(self.provider, 'logout', side_effect=AssertionError('Rejected logout reached provider')):
            self.assertEqual(self.request('POST', '/api/auth/logout', {}, cookie, csrf,
                                         origin='https://attacker.invalid')[0], 403)
            self.assertEqual(self.request('POST', '/api/auth/logout', {}, cookie, 'wrong-csrf')[0], 403)
        self.assertEqual(self.provider.calls, before)
        self.assertEqual(len(self.server.accounts.accounts.sessions), 1)
        self.provider.failure = None
        self.assertEqual(self.request('GET', '/api/chats', cookie=cookie)[0], 200)

    def test_outage_stale_session_is_only_usable_for_logout(self):
        cookie, csrf, _ = self.login(SECONDARY)
        self.provider.failure = AuthError('private issuer outage', 503)
        for method, path, body in (('GET', '/api/state', None), ('GET', '/api/auth/accounts', None),
                                   ('POST', '/api/auth/decide', {'uid': 'member', 'decision': 'approve'}),
                                   ('POST', '/api/action', {'action': 'sdk'})):
            code, value, _ = self.request(method, path, body, cookie, csrf)
            self.assertEqual(code, 503, path)
            self.assertNotIn('private issuer outage', str(value))
            self.assertNotIn('csrf', value)
            self.assertNotIn('user', value)
        self.assertEqual(self.request('POST', '/api/auth/logout', {}, cookie, csrf)[0], 200)

    def test_logout_unknown_expired_and_already_revoked_sessions_are_bounded(self):
        cookie, csrf, _ = self.login(SECONDARY)
        self.assertEqual(self.request('POST', '/api/auth/logout', {}, cookie, csrf)[0], 200)
        for supplied in (cookie, 'echo_workspace_session=' + 'x' * 40, None):
            code, value, _ = self.request('POST', '/api/auth/logout', {}, supplied, csrf)
            self.assertEqual(code, 401)
            self.assertNotIn('csrf', value)
        cookie, csrf, _ = self.login(SECONDARY)
        next(iter(self.server.accounts.accounts.sessions.values()))['expires'] = 0
        self.assertEqual(self.request('POST', '/api/auth/logout', {}, cookie, csrf)[0], 401)

    def test_local_logout_during_late_protected_verification_cannot_be_undone(self):
        cookie, csrf, _ = self.login(SECONDARY)
        entered, release = threading.Event(), threading.Event()
        self.provider.entered, self.provider.release = entered, release
        results = []
        worker = threading.Thread(target=lambda: results.append(self.request('GET', '/api/chats', cookie=cookie)[0]))
        worker.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertEqual(self.request('POST', '/api/auth/logout', {}, cookie, csrf)[0], 200)
        finally:
            release.set()
            worker.join(6)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results, [401])
        self.assertEqual(self.server.accounts.accounts.sessions, {})


if __name__ == '__main__':
    unittest.main()
