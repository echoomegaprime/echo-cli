import hashlib,json,sqlite3,tempfile,unittest
from pathlib import Path
from datetime import datetime,timezone,timedelta
from mission import Mission
from workspace import Store,verify_capture,WorkspaceError
from adapters import SyncWorker

class Improvements(unittest.TestCase):
 def test_excerpt_verification_requires_canonical_content_hash(self):
  job={'title':'Title','detail':'Record abc\n'+'long text '*2000}
  digest=hashlib.sha256((job['title'].strip()+'\n'+job['detail'].strip()).encode()).hexdigest()
  event={'id':'evt_a','content_text':'Title\nRecord abc\nlong text','excerpt_truncated':True,'content_sha256':digest}
  self.assertTrue(verify_capture(job,{'events':[event]}))
  event['content_sha256']='0'*64
  self.assertFalse(verify_capture(job,{'events':[event]}))
 def test_fabric_canonical_trim_is_verified_without_ignoring_content_changes(self):
  job={'title':'Title','detail':'Original text\n'}
  digest=hashlib.sha256(b'Title\nOriginal text').hexdigest()
  self.assertTrue(verify_capture(job,{'events':[{'id':'evt_trim','content_sha256':digest}]}))
  job['detail']='Different text\n'
  self.assertFalse(verify_capture(job,{'events':[{'id':'evt_trim','content_sha256':digest}]}))
 def test_retry_does_not_starve_later_jobs(self):
  with tempfile.TemporaryDirectory() as tmp:
   s=Store(tmp);s.new_chat();s.new_chat(); first=s.pending()[0]
   s.delivery(first['id'],'retry','temporary failure',delay=60)
   class Bridge:
    captured={}
    def call(self,plugin,tool,args):
     if tool=='continuity_capture': self.captured[args['requestId']]=args;return {'saved':True}
     p=self.captured[args['query']];return {'events':[{'id':'evt_ok','content_text':p['title']+'\n'+p['detail']}]}
   SyncWorker(s,Bridge()).once()
   self.assertEqual(s.sync_status()['verified'],1)
   self.assertEqual(s.pending()[0]['id'],first['id'])
 def test_revocation_and_halt_are_not_renewable(self):
  with tempfile.TemporaryDirectory() as tmp:
   cfg={'mission':{'enabled':True,'workspace':tmp,'role':'builder'}}
   m=Mission(cfg,tmp);m.identity={'run_id':'owned','token_hash':'hash','role':'builder'}
   db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
   db.execute('CREATE TABLE broker_tokens(token_hash,run_id,revoked,expires_at)')
   db.execute('INSERT INTO broker_tokens VALUES(?,?,?,?)',('hash','owned',1,(datetime.now(timezone.utc)+timedelta(hours=1)).isoformat()));db.commit()
   class State:
    status='running'
    def get_mission(self,r):return {'role':'builder','workspace':tmp,'status':self.status}
    def connect(self):return db
   m.store=State()
   m._cli=lambda *a: self.fail('revoked grants must not issue tokens')
   with self.assertRaisesRegex(WorkspaceError,'revoked'):m.ensure()
   m.store.status='halted'
   with self.assertRaisesRegex(WorkspaceError,'stopped'):m.ensure()
   db.close()
