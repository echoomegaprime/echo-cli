"""Remote MCP boundary and lifecycle checks; no live network or credentials."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from remote_mcp import MCPConnections, MCPError, validate_url, public_addresses, StreamableHTTP

class Cipher:
    def seal(self,value):return ('sealed:'+value).encode()
    def open(self,value):return value.decode().removeprefix('sealed:')

class Transport:
    calls=[]
    def __init__(self,url,token=''):self.url,self.token=url,token
    def discover(self):return [{'name':'lookup','description':'Search public docs','inputSchema':{'type':'object','properties':{'q':{'type':'string'}}}}]
    def call(self,name,args):self.calls.append((self.url,self.token,name,args));return {'content':[{'type':'text','text':'answer'}]}
    def close(self):pass

class ConnectionsTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.a=MCPConnections(self.root/'alice',cipher=Cipher(),transport=Transport)
        self.b=MCPConnections(self.root/'bob',cipher=Cipher(),transport=Transport)
    def tearDown(self):self.tmp.cleanup()
    def test_add_discover_enable_call_and_restart(self):
        row=self.a.add({'name':'Docs','url':'https://docs.example.com/mcp','auth':'bearer','token':'private-token'})
        self.assertEqual(row['tool_count'],1);self.assertNotIn('token',json.dumps(row))
        self.assertEqual(self.a.call(row['id'],'lookup',{'q':'hello'})['content'][0]['text'],'answer')
        fresh=MCPConnections(self.root/'alice',cipher=Cipher(),transport=Transport)
        self.assertEqual(fresh.list()[0]['name'],'Docs')
        fresh.set_enabled(row['id'],False)
        with self.assertRaises(MCPError):fresh.call(row['id'],'lookup',{})
    def test_other_account_cannot_get_call_remove_or_read_credentials(self):
        row=self.a.add({'name':'Private','url':'https://docs.example.com/mcp','auth':'bearer','token':'alice-token'})
        self.assertEqual(self.b.list(),[])
        for operation in [lambda:self.b.call(row['id'],'lookup',{}),lambda:self.b.remove(row['id']),lambda:self.b.tools(row['id'])]:
            with self.assertRaises(MCPError):operation()
        self.assertNotIn('alice-token',json.dumps(self.a.list()))
    def test_unknown_tool_rejected_before_network_and_remove_revokes(self):
        row=self.a.add({'name':'Docs','url':'https://docs.example.com/mcp','auth':'none'})
        before=len(Transport.calls)
        with self.assertRaises(MCPError):self.a.call(row['id'],'undeclared',{})
        self.assertEqual(len(Transport.calls),before)
        self.a.remove(row['id'])
        with self.assertRaises(MCPError):self.a.call(row['id'],'lookup',{})
    def test_invalid_auth_and_url_rejected_no_stored_connection(self):
        for body in [
            {'url':'http://example.com/mcp','name':'x'},
            {'url':'https://example.com/mcp?token=secret','name':'x'},
            {'url':'https://user:pass@example.com/mcp','name':'x'},
            {'url':'https://example.com/mcp','name':'x','auth':'bearer','token':'bad\nheader'},
            {'url':'https://example.com/mcp','name':'x','auth':'oauth'}]:
            with self.assertRaises(MCPError):self.a.add(body)
        self.assertEqual(self.a.list(),[])
    def test_escaped_credential_cannot_leak_through_discovery_or_results(self):
        token='opaque"' + chr(92) + 'credential'
        class Echo(Transport):
            def discover(self):return [{'name':'lookup','description':token,'inputSchema':{'type':'object'}}]
            def call(self,name,args):return {'content':[{'type':'text','text':token}]}
        self.a.transport=Echo
        row=self.a.add({'name':'Docs','url':'https://docs.example.com/mcp','auth':'bearer','token':token})
        self.assertNotIn(token,str(self.a.tools(row['id'])))
        self.assertNotEqual(self.a.tools(row['id'])['tools'][0]['description'],token)
        self.assertNotEqual(self.a.call(row['id'],'lookup',{})['content'][0]['text'],token)
    def test_response_cannot_echo_connection_credential(self):
        class Echo(Transport):
            def call(self,name,args):return {'content':[{'type':'text','text':'private-token'}]}
        self.a.transport=Echo
        row=self.a.add({'name':'Docs','url':'https://docs.example.com/mcp','auth':'bearer','token':'private-token'})
        self.assertNotIn('private-token',json.dumps(self.a.call(row['id'],'lookup',{})))

class AddressTests(unittest.TestCase):
    def test_rejects_private_mixed_dns_and_non_https(self):
        for url in ['http://example.com/mcp','https://127.0.0.1/mcp','https://[::1]/mcp','https://user:pass@x.com/mcp','https://example.com:22/mcp','https://localhost/mcp','https://x.local/mcp','https://x.com/mcp#fragment']:
            with self.assertRaises(MCPError):validate_url(url)
        def answers(*_,**kwargs):return [(2,1,6,'',('93.184.216.34',443)),(2,1,6,'',('127.0.0.1',443))]
        with patch('remote_mcp.socket.getaddrinfo',answers):
            with self.assertRaises(MCPError):public_addresses('example.com',443)
    def test_transport_initialize_notification_discovery_and_call(self):
        client=StreamableHTTP('https://docs.example.com/mcp')
        messages=[]
        def request(body):
            messages.append(body)
            if body['method']=='initialize':return {'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'test','version':'1'}}
            if body['method']=='tools/list':return {'tools':[{'name':'echo','inputSchema':{'type':'object'}}]}
            if body['method']=='tools/call':return {'content':[{'type':'text','text':'ok'}]}
            return {}
        client.request=request
        self.assertEqual(client.discover()[0]['name'],'echo')
        self.assertEqual([x['method'] for x in messages],['initialize','notifications/initialized','tools/list'])
        self.assertEqual(client.call('echo',{})['content'][0]['text'],'ok')
    def test_partial_utf8_chunk_is_bufferable_then_complete(self):
        wire=('data: '+json.dumps({'jsonrpc':'2.0','id':1,'result':{'text':'café'}},ensure_ascii=False)+'\n\n').encode()
        split=wire.index('é'.encode())+1
        with self.assertRaises(MCPError):StreamableHTTP.decode_events(wire[:split],1)
        self.assertEqual(StreamableHTTP.decode_events(wire,1),{'text':'café'})
    def test_sse_parser_matches_response_and_ignores_unrelated_events(self):
        data=b'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n'
        self.assertEqual(StreamableHTTP.decode_events(data,7),{'ok':True})
        with self.assertRaises(MCPError):StreamableHTTP.decode_events(b'data: {"jsonrpc":"2.0","id":8,"result":{}}\n\n',7)

if __name__=='__main__':unittest.main()
