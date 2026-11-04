"""Current-admission regressions. Offline issuer and temporary stores only."""
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from accounts import Accounts, AuthError
from test_accounts import Provider


class CurrentProvider(Provider):
    def __init__(self):
        self.calls = 0
        self.failure = None
        self.identity = None
        self.entered = self.release = None

    def verify(self, token):
        self.calls += 1
        if self.entered:
            self.entered.set()
            if not self.release.wait(4):
                raise TimeoutError('offline verification barrier expired')
        if self.failure:
            raise self.failure
        return self.identity if self.identity is not None else {
            **super().verify(token), 'exp': time.time() + 86400 * 30}


class CurrentAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.provider = CurrentProvider()
        self.accounts = Accounts(Path(self.tmp.name), {'owner_uids': ['owner']}, self.provider)
        self.token, self.owner, _ = self.login('owner')

    def login(self, name):
        return self.accounts.login({'email': name + '@example.test',
                                    'password': 'valid-test-password'}, '127.0.0.1')

    def test_each_resolve_revalidates_even_far_from_expiry(self):
        before = self.provider.calls
        for _ in range(3):
            self.assertEqual(self.accounts.resolve(self.token)['user']['uid'], 'owner')
        self.assertEqual(self.provider.calls - before, 3)

    def test_disabled_or_deleted_canonical_user_revokes_fresh_session(self):
        for reason in ('disabled', 'deleted'):
            with self.subTest(reason=reason):
                self.provider.failure = None
                token, _, _ = self.login('owner')
                self.provider.failure = AuthError('private issuer ' + reason, 401)
                self.assertIsNone(self.accounts.resolve(token))
                self.assertNotIn(self.accounts.key(token), self.accounts.sessions)

    def test_outage_fails_closed_503_without_revoking_retryable_session(self):
        for failure in (AuthError('private driver body', 503), OSError('private provider error')):
            with self.subTest(failure=type(failure).__name__):
                self.provider.failure = failure
                with self.assertRaises(AuthError) as error:
                    self.accounts.resolve(self.token)
                self.assertEqual(error.exception.status, 503)
                self.assertNotIn('private', str(error.exception))
                self.assertIn(self.accounts.key(self.token), self.accounts.sessions)
        self.provider.failure = None
        self.assertIsNotNone(self.accounts.resolve(self.token))

    def test_invalid_or_mismatched_verified_response_revokes(self):
        invalid = [{}, None, [], {'uid': 'other', 'email': 'other@example.test', 'email_verified': True},
                   {'uid': 'owner', 'email': 'owner@example.test', 'email_verified': False},
                   {'uid': 'owner', 'email_verified': True},
                   {'uid': 'owner', 'email': 'owner@example.test', 'email_verified': True, 'exp': float('nan')}]
        for value in invalid:
            with self.subTest(value=value):
                self.provider.identity = None
                token, _, _ = self.login('owner')
                with patch.object(self.provider, 'verify', return_value=value):
                    self.assertIsNone(self.accounts.resolve(token))
                    self.assertNotIn(self.accounts.key(token), self.accounts.sessions)

    def test_refresh_is_verified_and_keeps_rotated_credentials_only_in_memory(self):
        session = self.accounts.sessions[self.accounts.key(self.token)]
        session.update(provider_expires=0, refresh_token='offline-refresh')
        self.provider.refresh = lambda token: {'access_token': 'test-owner', 'refresh_token': 'offline-rotated'}
        before = self.provider.calls
        self.assertIsNotNone(self.accounts.resolve(self.token))
        self.assertEqual(self.provider.calls, before + 1)
        self.assertEqual(session['refresh_token'], 'offline-rotated')
        self.assertGreater(session['provider_expires'], time.time())

    def test_mismatched_refresh_cannot_replace_session_identity(self):
        session = self.accounts.sessions[self.accounts.key(self.token)]
        session.update(provider_expires=0, refresh_token='offline-refresh')
        self.provider.refresh = lambda token: {'access_token': 'test-other'}
        self.assertIsNone(self.accounts.resolve(self.token))
        self.assertNotIn(self.accounts.key(self.token), self.accounts.sessions)

    def test_rotation_verification_outage_never_replays_consumed_refresh(self):
        session = self.accounts.sessions[self.accounts.key(self.token)]
        session.update(provider_expires=0, refresh_token='offline-one-use-refresh')
        calls = []
        def refresh(token):
            calls.append(token)
            if calls.count(token) > 1:
                raise AuthError('private consumed refresh detail', 401)
            return {'access_token': 'test-owner', 'refresh_token': 'offline-next-refresh'}
        self.provider.refresh = refresh
        self.provider.failure = AuthError('private post-rotation issuer detail', 503)
        with self.assertRaises(AuthError) as error:
            self.accounts.resolve(self.token)
        self.assertEqual(error.exception.status, 503)
        self.assertNotIn('private', str(error.exception))
        self.provider.failure = None
        self.assertIsNone(self.accounts.resolve(self.token))
        self.assertEqual(calls, ['offline-one-use-refresh'])
        self.assertNotIn(self.accounts.key(self.token), self.accounts.sessions)

    def test_ambiguous_refresh_transport_failure_requires_fresh_sign_in(self):
        for failure in (AuthError('private rotation detail', 503), OSError('private transport detail')):
            with self.subTest(failure=type(failure).__name__):
                token, _, _ = self.login('owner')
                session = self.accounts.sessions[self.accounts.key(token)]
                session.update(provider_expires=0, refresh_token='offline-one-use-refresh')
                calls = []
                def refresh(value):
                    calls.append(value)
                    raise failure
                self.provider.refresh = refresh
                with self.assertRaises(AuthError) as error:
                    self.accounts.resolve(token)
                self.assertEqual(error.exception.status, 503)
                self.assertNotIn('private', str(error.exception))
                self.assertNotIn(self.accounts.key(token), self.accounts.sessions)
                self.assertIsNone(self.accounts.resolve(token))
                self.assertEqual(calls, ['offline-one-use-refresh'])

    def test_post_rotation_non_auth_verifier_failure_cannot_retry_old_refresh(self):
        session = self.accounts.sessions[self.accounts.key(self.token)]
        session.update(provider_expires=0, refresh_token='offline-one-use-refresh')
        self.provider.refresh = lambda value: {'access_token': 'test-owner', 'refresh_token': 'offline-next-refresh'}
        self.provider.failure = OSError('private verifier transport detail')
        with self.assertRaises(AuthError) as error:
            self.accounts.resolve(self.token)
        self.assertEqual(error.exception.status, 503)
        self.provider.failure = None
        self.assertIsNone(self.accounts.resolve(self.token))
        self.assertNotIn(self.accounts.key(self.token), self.accounts.sessions)

    def test_successful_rotation_then_next_request_verifies_without_second_refresh(self):
        session = self.accounts.sessions[self.accounts.key(self.token)]
        session.update(provider_expires=0, refresh_token='offline-one-use-refresh')
        calls = []
        def refresh(value):
            calls.append(value)
            return {'access_token': 'test-owner', 'refresh_token': 'offline-next-refresh'}
        self.provider.refresh = refresh
        before = self.provider.calls
        self.assertIsNotNone(self.accounts.resolve(self.token))
        self.assertIsNotNone(self.accounts.resolve(self.token))
        self.assertEqual(calls, ['offline-one-use-refresh'])
        self.assertEqual(self.provider.calls - before, 2)
        self.assertEqual(session['refresh_token'], 'offline-next-refresh')

    def test_verified_rotation_without_replacement_never_reuses_old_refresh(self):
        session = self.accounts.sessions[self.accounts.key(self.token)]
        session.update(provider_expires=0, refresh_token='offline-one-use-refresh')
        calls = []
        def refresh(value):
            calls.append(value)
            return {'access_token': 'test-owner'}
        self.provider.refresh = refresh
        self.assertIsNotNone(self.accounts.resolve(self.token))
        session['provider_expires'] = 0
        self.assertIsNone(self.accounts.resolve(self.token))
        self.assertEqual(calls, ['offline-one-use-refresh'])

    def test_rotation_outage_audit_has_only_bounded_metadata(self):
        session = self.accounts.sessions[self.accounts.key(self.token)]
        session.update(provider_expires=0, refresh_token='offline-one-use-refresh')
        self.provider.refresh = lambda value: {'access_token': 'test-owner', 'refresh_token': 'offline-next-refresh'}
        self.provider.failure = AuthError('private issuer exception body', 503)
        with self.assertRaises(AuthError):
            self.accounts.resolve(self.token)
        checks = [json.loads(line) for line in self.accounts.audit.read_text().splitlines()
                  if json.loads(line)['operation'] == 'session_verify']
        self.assertEqual(checks[-1].get('error_category'), 'refresh_unconfirmed')
        self.assertEqual(checks[-1]['http_status'], 503)
        self.assertEqual(checks[-1]['status'], 'unavailable')
        self.assertLess(len(json.dumps(checks[-1])), 300)
        for value in (self.token, session['csrf'], 'offline-one-use-refresh', 'offline-next-refresh',
                      'test-owner', 'owner@example.test', 'private issuer exception body'):
            self.assertNotIn(value, json.dumps(checks))

    def late_verification(self, token, action):
        entered, release = threading.Event(), threading.Event()
        self.provider.entered, self.provider.release = entered, release
        result, errors = [], []
        def resolve():
            try:
                result.append(self.accounts.resolve(token))
            except Exception as exc:
                errors.append(exc)
        worker = threading.Thread(target=resolve)
        worker.start()
        try:
            self.assertTrue(entered.wait(1), 'Protected request skipped the current verifier')
            action()
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        return result[0]

    def test_logout_during_late_verify_cannot_resurrect_session(self):
        result = self.late_verification(self.token, lambda: self.accounts.logout(self.token))
        self.assertIsNone(result)
        self.assertNotIn(self.accounts.key(self.token), self.accounts.sessions)

    def test_logout_during_late_refresh_cannot_install_rotated_credentials(self):
        session = self.accounts.sessions[self.accounts.key(self.token)]
        session.update(provider_expires=0, refresh_token='offline-refresh')
        self.provider.refresh = lambda token: {'access_token': 'test-owner', 'refresh_token': 'offline-rotated'}
        result = self.late_verification(self.token, lambda: self.accounts.logout(self.token))
        self.assertIsNone(result)
        self.assertEqual(session['refresh_token'], 'offline-refresh')
        self.assertNotIn(self.accounts.key(self.token), self.accounts.sessions)

    def test_local_user_deletion_during_verification_cannot_be_readmitted(self):
        def delete_user():
            with self.accounts.db() as db:
                db.execute('DELETE FROM users WHERE uid=?', ('owner',))
        self.assertIsNone(self.late_verification(self.token, delete_user))
        self.assertIsNone(self.accounts.user('owner'))

    def test_logout_during_local_status_read_cannot_return_an_admitted_session(self):
        original = self.accounts.user
        def read_user(uid):
            user = original(uid)
            self.accounts.logout(self.token)
            return user
        with patch.object(self.accounts, 'user', side_effect=read_user):
            self.assertIsNone(self.accounts.resolve(self.token))

    def test_denial_during_late_verify_is_immediate(self):
        token, alice, _ = self.login('alice')
        self.accounts.decide(self.owner, alice['uid'], 'approve')
        result = self.late_verification(token, lambda: self.accounts.decide(self.owner, 'alice', 'deny'))
        self.assertEqual(result['user']['status'], 'denied')

    def test_expiry_during_late_verify_cannot_admit(self):
        session = self.accounts.sessions[self.accounts.key(self.token)]
        self.assertIsNone(self.late_verification(self.token, lambda: session.update(expires=0)))

    def test_no_global_lock_during_current_verification(self):
        other, _, _ = self.login('alice')
        entered, release = threading.Event(), threading.Event()
        original = self.provider.verify
        def verify(token):
            if token == 'test-owner':
                entered.set()
                release.wait(4)
            return original(token)
        self.provider.verify = verify
        worker = threading.Thread(target=lambda: self.accounts.resolve(self.token))
        worker.start()
        done = threading.Event()
        second = threading.Thread(target=lambda: (self.accounts.resolve(other), done.set()))
        try:
            self.assertTrue(entered.wait(1), 'Protected request skipped current verification')
            second.start()
            self.assertTrue(done.wait(1), 'Unrelated account serialized behind network I/O')
        finally:
            release.set()
            worker.join(5)
            if second.ident:
                second.join(5)

    def test_audit_has_safe_categories_and_no_identity_or_provider_text(self):
        self.accounts.resolve(self.token)
        self.provider.failure = AuthError('private issuer driver body', 503)
        try:
            self.accounts.resolve(self.token)
        except AuthError:
            pass
        rows = [json.loads(line) for line in self.accounts.audit.read_text().splitlines()]
        checks = [row for row in rows if row['operation'] == 'session_verify']
        self.assertTrue(any(row['status'] == 'accepted' for row in checks))
        self.assertTrue(any(row['status'] == 'unavailable' and row['http_status'] == 503 for row in checks))
        raw = json.dumps(checks)
        for secret in ('private issuer', 'owner', '@example.test', self.token, 'test-owner'):
            self.assertNotIn(secret, raw)


if __name__ == '__main__':
    unittest.main()
