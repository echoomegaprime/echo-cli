"""Ingress, provider forwarding and public login regression tests (offline)."""
import http.client
import json
import socket
import tempfile
import threading
import time
import unittest
from email.message import Message
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from accounts import AuthError, IdentityClient
from app import Application, make_server
from test_accounts import Provider

class IngressTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.app=Application(Path(self.tmp.name),{'auth':{'enabled':True,'owner_uids':['owner'],'trusted_proxy_ips':['127.0.0.1']},
            'public_origins':['https://echoomegaprime.com'],'http_read_timeout':1,'http_max_requests':4})
        self.server=make_server(self.app,0)
        self.provider=Provider()
        self.provider.client_config=Mock(return_value={'google_login_enabled':True,'google_client_id':'public-test-id'})
        self.provider.signup=Mock();self.provider.reset=Mock()
        self.server.accounts.accounts.provider=self.provider
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.port=self.server.server_port
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def headers(self, host='echoomegaprime.com', values=('203.0.113.10',), peer='127.0.0.1'):
        h=Message();h['Host']=host
        for value in values:h['CF-Connecting-IP']=value
        h['X-Forwarded-For']='198.51.100.66'
        return SimpleNamespace(headers=h,client_address=(peer,123),server=self.server)
    def request(self, method, path, body=None, extra=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.port,timeout=4)
        headers={'Host':'echoomegaprime.com','Origin':'https://echoomegaprime.com','CF-Connecting-IP':'203.0.113.10'}
        if body is not None:headers.update({'Content-Type':'application/json','X-Echo-CSRF':'login'})
        headers.update(extra or {})
        conn.request(method,path,None if body is None else json.dumps(body),headers)
        r=conn.getresponse();raw=r.read();result=(r.status,dict(r.getheaders()),raw);conn.close();return result
    def test_proxy_identity_only_from_validated_single_header_and_trusted_peer(self):
        gate=self.server.accounts
        self.assertEqual(gate.client_ip(self.headers()),'203.0.113.10')
        self.assertEqual(gate.client_ip(self.headers(peer='192.0.2.5')),'192.0.2.5')
        self.assertEqual(gate.client_ip(self.headers(host='127.0.0.1:'+str(self.port))),'127.0.0.1')
        for values in [(),('invalid',),('203.0.113.1, 203.0.113.2',),('203.0.113.1','203.0.113.2')]:
            with self.assertRaises(AuthError):gate.client_ip(self.headers(values=values))
    def test_public_cookie_and_signup_recovery_forward_same_derived_identity(self):
        code,headers,_=self.request('POST','/api/auth/login',{'email':'owner@example.test','password':'valid-test-password'})
        self.assertEqual(code,200)
        self.assertIn('; Secure',headers['Set-Cookie']);self.assertIn('HttpOnly',headers['Set-Cookie'])
        for action in ('signup','reset'):
            self.assertEqual(self.request('POST','/api/auth/'+action,{'email':'alice@example.test'})[0],202)
            self.assertEqual(getattr(self.provider,action).call_args.kwargs['client_ip'],'203.0.113.10')
    def test_anonymous_config_cached_and_login_csp(self):
        for _ in range(3):self.assertEqual(self.request('GET','/api/auth/config')[0],200)
        self.assertEqual(self.provider.client_config.call_count,1)
        code,headers,_=self.request('GET','/login')
        self.assertEqual(code,200);self.assertIn('https://accounts.google.com/gsi/style',headers['Content-Security-Policy'])
        self.assertEqual(headers['Referrer-Policy'],'strict-origin-when-cross-origin')
    def test_member_health_preserves_private_memory_mode_and_missing_audio_is_404(self):
        ac=self.server.accounts.accounts
        _,owner,_=ac.login({'email':'owner@example.test','password':'valid-test-password'},'127.0.0.1')
        token,user,_=ac.login({'email':'alice@example.test','password':'valid-test-password'},'127.0.0.1')
        ac.decide(owner,user['uid'],'approve')
        member=self.server.accounts.application(ac.user(user['uid']))
        member.model.status=lambda:{'ok':True}
        extra={'Cookie':'echo_workspace_session='+token}
        code,_,raw=self.request('GET','/api/health',extra=extra)
        self.assertEqual(code,200);self.assertEqual(json.loads(raw)['sync']['mode'],'private_local')
        self.assertEqual(self.request('GET','/api/voice/audio/00000000000000000000000000000000',extra=extra)[0],404)
    def test_privacy_notice_is_public_without_exposing_account_data(self):
        code,_,raw=self.request('GET','/privacy')
        self.assertEqual(code,200)
        self.assertIn(b'WORKSPACE PRIVACY',raw)
        self.assertIn(b'echoomegaprime@gmail.com',raw)
        self.assertNotIn(b'owner@example.test',raw)
        self.assertEqual(self.request('GET','/api/auth/accounts')[0],404)

    def test_incomplete_body_is_released_by_timeout(self):
        sock=socket.create_connection(('127.0.0.1',self.port),timeout=4)
        try:
            sock.sendall(b'POST /api/auth/login HTTP/1.1\r\nHost: echoomegaprime.com\r\nOrigin: https://echoomegaprime.com\r\nCF-Connecting-IP: 203.0.113.10\r\nX-Echo-CSRF: login\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{')
            self.assertIn(b'408',sock.recv(4096))
        finally:sock.close()
    def test_concurrency_limit_returns_503(self):
        sockets=[socket.create_connection(('127.0.0.1',self.port),timeout=3) for _ in range(4)]
        try:
            time.sleep(.15)
            code,_,_=self.request('GET','/login')
            self.assertEqual(code,503)
        finally:
            for sock in sockets:sock.close()

class ProviderForwardingTests(unittest.TestCase):
    def test_derived_ip_forwarded_no_body_override(self):
        client=IdentityClient('https://auth.echo-op.com')
        response=Mock();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False);response.read.return_value=b'{}'
        client.http.open=Mock(return_value=response)
        for method,body in [('signup',{'email':'a@example.test','client_ip':'198.51.100.1'}),('reset',{'email':'a@example.test'}),('login',{'email':'a@example.test','password':'test'})]:
            getattr(client,method)(body,client_ip='203.0.113.9')
            request=client.http.open.call_args.args[0]
            self.assertEqual(request.get_header('X-forwarded-for'),'203.0.113.9')
            self.assertNotIn(b'client_ip',request.data)
        with self.assertRaises(ValueError):client.request('/v1/client-config',client_ip='bad\r\nX-Test: a')


class WorkspaceClientSelectionTests(unittest.TestCase):
    def test_configured_client_is_selected_through_identity_service(self):
        client=IdentityClient('https://auth.echo-op.com',google_client_id='workspace.apps.googleusercontent.com')
        response=Mock();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
        response.read.return_value=b'{"google_login_enabled":true,"google_client_id":"workspace.apps.googleusercontent.com"}'
        client.http.open=Mock(return_value=response)
        self.assertEqual(client.client_config()['google_client_id'],'workspace.apps.googleusercontent.com')
        self.assertEqual(client.http.open.call_args.args[0].full_url,
                         'https://auth.echo-op.com/v1/client-config?client_id=workspace.apps.googleusercontent.com')

    def test_mismatched_provider_client_fails_closed(self):
        client=IdentityClient('https://auth.echo-op.com',google_client_id='workspace.apps.googleusercontent.com')
        client.request=Mock(return_value={'google_login_enabled':True,'google_client_id':'legacy.apps.googleusercontent.com'})
        with self.assertRaises(AuthError):client.client_config()

    def test_default_configuration_retains_existing_provider(self):
        client=IdentityClient('https://auth.echo-op.com')
        client.request=Mock(return_value={'google_login_enabled':True,'google_client_id':'legacy.apps.googleusercontent.com'})
        self.assertEqual(client.client_config()['google_client_id'],'legacy.apps.googleusercontent.com')
        client.request.assert_called_once_with('/v1/client-config')

if __name__=='__main__':unittest.main()
