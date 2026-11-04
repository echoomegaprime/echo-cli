import tempfile
import unittest
from pathlib import Path
from accounts import Accounts, ApprovalNotifier
from test_accounts import Provider

class NotificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.accounts=Accounts(Path(self.tmp.name),{'owner_uids':['owner']},Provider())
        self.accounts.login({'email':'alice@example.test','password':'valid-test-password'},'one')
        self.calls=[]
    def tearDown(self):self.tmp.cleanup()
    def send(self,cap,command,options):
        self.calls.append((cap,command,options))
        return {'ok':True,'message_id':17}
    def test_exact_owner_destination_and_idempotent_receipt(self):
        notifier=ApprovalNotifier(self.accounts,self.send,'123456','https://echoomegaprime.com')
        self.assertEqual(notifier.once()['sent'],1);self.assertEqual(notifier.once()['sent'],0)
        self.assertEqual(len(self.calls),1)
        self.assertEqual(self.calls[0][2]['chat_id'],'123456')
        self.assertIn('decision=approve',self.calls[0][2]['text']);self.assertIn('decision=deny',self.calls[0][2]['text'])
        self.assertNotIn('test-alice',self.calls[0][2]['text'])
    def test_ambiguous_send_not_replayed_and_no_admission(self):
        def failed(*args):raise TimeoutError()
        notifier=ApprovalNotifier(self.accounts,failed,'123456','https://echoomegaprime.com')
        self.assertEqual(notifier.once()['uncertain'],1)
        self.assertEqual(notifier.once()['uncertain'],0)
        self.assertEqual(self.accounts.user('alice')['status'],'pending')
    def test_success_without_message_receipt_is_not_marked_sent(self):
        notifier=ApprovalNotifier(self.accounts,lambda *args:{'ok':True},'123456','https://echoomegaprime.com')
        self.assertEqual(notifier.once()['uncertain'],1)

if __name__=='__main__':unittest.main()
