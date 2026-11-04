"""HTTP authorization and isolation against two real isolated Workspace stores."""
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from app import Application, make_server
from accounts import Accounts
from test_accounts import Provider

class HttpIsolationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.owner = Application(self.root/'owner', {'auth':{'enabled':True,'owner_uids':['owner']}})
        self.server = make_server(self.owner,0)
        self.server.accounts.accounts.provider = Provider()
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.port = self.server.server_port
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.tmp.cleanup()
    def request(self, method, path, body=None, cookie=None, csrf=None, origin=None):
        conn = http.client.HTTPConnection('127.0.0.1',self.port,timeout=8)
        headers={}
        if cookie: headers['Cookie']=cookie
        if method=='POST':
            headers.update({'Content-Type':'application/json','X-Echo-CSRF':csrf or 'login','Origin':origin or 'http://127.0.0.1:'+str(self.port)})
        conn.request(method,path,None if body is None else json.dumps(body),headers)
        response=conn.getresponse();raw=response.read();status=response.status;cookie=response.getheader('Set-Cookie')
        conn.close()
        try:value=json.loads(raw)
        except ValueError:value=raw.decode()
        return status,value,cookie
    def login(self,name):
        code,v,cookie=self.request('POST','/api/auth/login',{'email':name+'@example.test','password':'valid-test-password'})
        self.assertEqual(code,200)
        return cookie.split(';')[0],v['csrf'],v['user']
    def test_anonymous_cannot_read_or_write_and_no_forged_identity(self):
        for p in ['/api/state','/api/chats','/api/diagnostics','/api/plugins','/api/catalog','/api/fleet','/api/voice/audio/abc']:
            self.assertEqual(self.request('GET',p)[0],401,p)
        self.assertEqual(self.request('POST','/api/chats',{'title':'x','uid':'owner'})[0],401)
        self.assertEqual(self.request('GET','/')[0],303)
    def test_login_csrf_and_pending_gate(self):
        self.assertEqual(self.request('POST','/api/auth/login',{'email':'owner@example.test','password':'valid-test-password'},origin='https://attacker.invalid')[0],403)
        cookie,csrf,user=self.login('alice')
        self.assertEqual(user['status'],'pending')
        self.assertEqual(self.request('GET','/api/chats',cookie=cookie)[0],403)
    def test_cross_user_chats_projects_library_journal_memories_and_privilege(self):
        owner_cookie,owner_csrf,_=self.login('owner')
        a,ac,au=self.login('alice'); b,bc,bu=self.login('bob')
        for u in (au,bu):
            code,_,_=self.request('POST','/api/auth/decide',{'uid':u['uid'],'decision':'approve'},owner_cookie,owner_csrf)
            self.assertEqual(code,200)
        _,ca,_=self.request('POST','/api/chats',{'title':'Alice private'},a,ac)
        _,cb,_=self.request('POST','/api/chats',{'title':'Bob private'},b,bc)
        _,proj,_=self.request('POST','/api/projects',{'name':'Alice project'},a,ac)
        _,art,_=self.request('POST','/api/library',{'name':'private.txt','content':'ALICE_PRIVATE','chat_id':ca['id']},a,ac)
        self.request('POST','/api/action',{'action':'memory_save','content':'Remember ALICE_MEMORY','chat_id':ca['id']},a,ac)
        for p in ['/api/chats/'+ca['id'],'/api/journals/'+ca['id'],'/api/library/'+art['id']]:
            code,v,_=self.request('GET',p,cookie=b)
            self.assertEqual(code,404,p)
            self.assertNotIn('ALICE_',str(v))
        code,v,_=self.request('POST','/api/chats',{'title':'stolen project','project_id':proj['id']},b,bc)
        self.assertEqual(code,400)
        code,v,_=self.request('POST','/api/action',{'action':'memory_save','content':'tamper','chat_id':ca['id']},b,bc)
        self.assertEqual(code,400)
        for action in ['sdk','esh','vault','crystal_save','memory_search']:
            code,v,_=self.request('POST','/api/action',{'action':action,'chat_id':cb['id'],'command':'hostname'},b,bc)
            self.assertEqual(code,403,action)
        self.assertEqual(self.request('POST','/api/auth/decide',{'uid':'alice','decision':'approve'},b,bc)[0],403)
        code,v,_=self.request('GET','/api/state',cookie=b)
        self.assertEqual(code,200);self.assertNotIn('ALICE_',str(v));self.assertEqual(v['preferences'],[])
        self.assertEqual(self.request('POST','/api/chats',{'title':'csrf'},a,bc)[0],403)
        self.request('POST','/api/auth/decide',{'uid':'bob','decision':'deny'},owner_cookie,owner_csrf)
        self.assertEqual(self.request('GET','/api/chats',cookie=b)[0],403)
    def test_mcp_asset_and_connections_are_scoped_to_the_signed_in_account(self):
        from test_remote_mcp import Cipher, Transport
        owner_cookie,owner_csrf,_=self.login('owner')
        alice,ac,au=self.login('alice');bob,bc,bu=self.login('bob')
        owner=self.server.accounts.accounts.user('owner')
        for user in (au,bu):self.server.accounts.accounts.decide(owner,user['uid'],'approve')
        app=self.server.accounts.application(self.server.accounts.accounts.user('alice'))
        app.mcp.cipher=Cipher();app.mcp.transport=Transport
        self.assertEqual(self.request('GET','/mcp.js',cookie=alice)[0],200)
        code,row,_=self.request('POST','/api/mcp',{'action':'add','name':'Private docs','url':'https://example.com/mcp','auth':'none'},alice,ac)
        self.assertEqual(code,200)
        self.assertEqual(self.request('GET','/api/mcp',cookie=bob)[1]['connections'],[])
        self.assertEqual(self.request('GET','/api/mcp/tools/'+row['id'],cookie=bob)[0],404)
        self.assertEqual(self.request('POST','/api/mcp',{'action':'remove','id':row['id']},bob,bc)[0],400)
        self.assertEqual(self.request('POST','/api/mcp',{'action':'enable','id':row['id'],'enabled':False},alice,bc)[0],403)
        chat=app.store.new_chat('MCP receipt verification')
        result=app.tools.execute('mcp_call',{'server_id':row['id'],'tool':'lookup','arguments':{'q':'test'}},chat['id'],'mcp-boundary-test')
        self.assertEqual(result['content'][0]['text'],'answer')
        self.assertTrue(any(e['kind']=='tool_result' for e in app.store.chat(chat['id'])['events']))

    def test_owner_existing_history_preserved_only_owner(self):
        c=self.owner.store.new_chat('OWNER_PRIVATE')
        owner,_,_=self.login('owner')
        self.assertEqual(self.request('GET','/api/chats/'+c['id'],cookie=owner)[0],200)
        a,_,au=self.login('alice')
        self.server.accounts.accounts.decide(self.server.accounts.accounts.user('owner'),au['uid'],'approve')
        self.assertEqual(self.request('GET','/api/chats/'+c['id'],cookie=a)[0],404)

if __name__=='__main__':unittest.main()
