"""Identity and tenant boundaries: no test contacts the live auth provider."""
import tempfile
import unittest
from pathlib import Path
from accounts import Accounts, AuthError

class Provider:
    def login(self, body, client_ip=None):
        if body.get('password') != 'valid-test-password':
            raise AuthError('Sign-in failed.', 401)
        uid = body['email'].split('@')[0]
        return {'access_token': 'test-' + uid}
    def verify(self, token):
        return {'uid': token.removeprefix('test-'), 'email': token.removeprefix('test-') + '@example.test', 'email_verified': True}
    def logout(self, session): pass

class AccountTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.accounts = Accounts(self.root, {'owner_uids':['owner'], 'session_seconds':3600}, Provider())
    def tearDown(self): self.tmp.cleanup()
    def login(self, name):
        return self.accounts.login({'email':name+'@example.test','password':'valid-test-password'}, '127.0.0.1')
    def test_unknown_and_forged_session_rejected(self):
        self.assertIsNone(self.accounts.resolve('invented'))
        with self.assertRaises(AuthError):
            self.accounts.login({'email':'owner@example.test','password':'wrong'}, '127.0.0.2')
    def test_owner_is_verified_uid_not_client_role(self):
        token, user, csrf = self.accounts.login({'email':'alice@example.test','password':'valid-test-password','role':'owner','uid':'owner'},'127.0.0.1')
        self.assertEqual(user['role'], 'member')
        self.assertEqual(user['status'], 'pending')
        self.assertNotIn('test-alice', str(user))
        self.assertEqual(self.login('owner')[1]['status'], 'approved')
    def test_pending_deny_approve_and_immediate_revocation(self):
        owner = self.login('owner')[1]
        token, alice, _ = self.login('alice')
        self.accounts.decide(owner, alice['uid'], 'approve')
        self.assertEqual(self.accounts.resolve(token)['user']['status'], 'approved')
        self.accounts.decide(owner, alice['uid'], 'deny')
        self.assertEqual(self.accounts.resolve(token)['user']['status'], 'denied')
        with self.assertRaises(AuthError):
            self.accounts.decide(alice, owner['uid'], 'approve')
    def test_logout_and_expiry(self):
        token, _, _ = self.login('owner')
        self.accounts.logout(token)
        self.assertIsNone(self.accounts.resolve(token))
        token, _, _ = self.login('owner')
        self.accounts.sessions[self.accounts.key(token)]['expires'] = 0
        self.assertIsNone(self.accounts.resolve(token))
    def test_approval_survives_restart_no_password_or_tokens_on_disk(self):
        owner = self.login('owner')[1]
        _, alice, _ = self.login('alice')
        self.accounts.decide(owner, alice['uid'], 'approve')
        fresh = Accounts(self.root, {'owner_uids':['owner']}, Provider())
        self.assertEqual(fresh.user('alice')['status'], 'approved')
        raw = b''.join(p.read_bytes() for p in self.root.rglob('*') if p.is_file())
        for secret in [b'valid-test-password',b'test-alice',b'test-owner']:
            self.assertNotIn(secret,raw)
    def test_identity_not_verified_cannot_enter(self):
        self.accounts.provider.verify = lambda t: {'uid':'alice','email_verified':False}
        with self.assertRaises(AuthError): self.login('alice')
    def test_identity_error_does_not_create_session(self):
        self.accounts.provider.verify = lambda t: {}
        with self.assertRaises(AuthError): self.login('alice')
        self.assertEqual(len(self.accounts.sessions), 0)
    def test_local_rate_limit(self):
        for _ in range(10):
            try:self.accounts.login({'email':'x','password':'wrong'},'10.0.0.2')
            except AuthError:pass
        with self.assertRaises(AuthError) as e:self.accounts.login({'email':'x','password':'valid-test-password'},'10.0.0.2')
        self.assertEqual(e.exception.status,429)

if __name__ == '__main__': unittest.main()
