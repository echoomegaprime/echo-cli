"""Regression tests from independent authentication review."""
import tempfile
import threading
import time
import unittest
from pathlib import Path
from accounts import Accounts, AuthError
from test_accounts import Provider

class AuthHardeningTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name)
        self.accounts=Accounts(self.root,{'owner_uids':['owner']},Provider())
    def tearDown(self):self.tmp.cleanup()
    def test_successes_do_not_lock_out_other_users(self):
        for _ in range(12):
            self.accounts.login({'email':'owner@example.test','password':'valid-test-password'},'proxy')
        self.accounts.login({'email':'alice@example.test','password':'valid-test-password'},'proxy')
    def test_failed_account_limit_does_not_block_owner_behind_same_proxy(self):
        for _ in range(10):
            try:self.accounts.login({'email':'alice@example.test','password':'bad'},'proxy')
            except AuthError:pass
        with self.assertRaises(AuthError) as exc:
            self.accounts.login({'email':'alice@example.test','password':'valid-test-password'},'other-proxy')
        self.assertEqual(exc.exception.status,429)
        self.accounts.login({'email':'owner@example.test','password':'valid-test-password'},'proxy')
    def test_invalid_google_from_one_peer_does_not_block_other_users(self):
        def social(body, client_ip=None):
            if body.get('id_token')!='valid':raise AuthError('Invalid identity.',401)
            return {'access_token':'test-alice'}
        self.accounts.provider.login=social
        for _ in range(10):
            try:self.accounts.login({'provider':'google','id_token':'bad'},'one')
            except AuthError:pass
        self.accounts.login({'provider':'google','id_token':'valid'},'two')

    def test_auth_audit_records_actor_target_and_result_without_credentials(self):
        _,owner,_=self.accounts.login({'email':'owner@example.test','password':'valid-test-password'},'one')
        self.accounts.login({'email':'alice@example.test','password':'valid-test-password'},'two')
        self.accounts.decide(owner,'alice','approve')
        text=(self.root/'authentication.jsonl').read_text()
        self.assertIn('"tenant"',text);self.assertIn('"actor"',text);self.assertIn('"admission"',text)
        self.assertNotIn('test-owner',text);self.assertNotIn('valid-test-password',text)
    def test_one_refresh_does_not_lock_other_sessions(self):
        a,_,_=self.accounts.login({'email':'owner@example.test','password':'valid-test-password'},'a')
        b,_,_=self.accounts.login({'email':'alice@example.test','password':'valid-test-password'},'b')
        session=self.accounts.sessions[self.accounts.key(a)];session.update(provider_expires=0,refresh_token='refresh')
        entered,release,done=threading.Event(),threading.Event(),threading.Event()
        def refresh(token):
            entered.set();release.wait(3);return {'access_token':'test-owner'}
        self.accounts.provider.refresh=refresh
        thread=threading.Thread(target=lambda:self.accounts.resolve(a));thread.start();self.assertTrue(entered.wait(1))
        other=threading.Thread(target=lambda:(self.accounts.resolve(b),done.set()));other.start()
        try:self.assertTrue(done.wait(.5),'Another account is blocked by an unrelated refresh')
        finally:release.set();thread.join();other.join()

if __name__=='__main__':unittest.main()
