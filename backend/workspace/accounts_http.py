"""HTTP session gate and application selection; identity is never supplied by request parameters."""
import copy
import json
import ipaddress
import logging
import re
import time
import secrets
import threading
from pathlib import Path
from urllib.parse import urlsplit
from accounts import Accounts, AuthError
from audit import record

PUBLIC_FILES = {'/privacy':('privacy.html','text/html'),'/login':('login.html','text/html'),'/auth.js':('auth.js','text/javascript'),'/auth.css':('auth.css','text/css'),'/echo-icon.png':('echo-icon.png','image/png')}
SAFE_ACTIONS = {'memory_save','memory_forget','personality_select'}

class WorkspaceAccounts:
    def __init__(self, owner):
        self.owner = owner
        self.config = owner.config.get('auth',{})
        self.accounts = Accounts(owner.store.root/'identity',self.config)
        legacy = self.config.get('legacy_data_owner_uid')
        if 'legacy_data_owner_uid' not in self.config and len(self.accounts.owners)==1:
            legacy = next(iter(self.accounts.owners))
        # Storage policy does not change verified roles or account administration.
        self.legacy_data_owner_uid = legacy if isinstance(legacy,str) and legacy in self.accounts.owners else None
        self.apps, self.lock = {}, threading.Lock()
        self.proxy_ips = {str(ipaddress.ip_address(x)) for x in self.config.get("trusted_proxy_ips",[])}
        self.config_lock, self.public_config, self.config_until = threading.Lock(), None, 0
        self.origins = set(owner.config.get('public_origins',[]))
        if any(urlsplit(x).scheme!='https' or urlsplit(x).path or urlsplit(x).query or urlsplit(x).fragment or urlsplit(x).username for x in self.origins):
            raise ValueError('Public origins must be exact HTTPS origins without paths.')
    def client_ip(self, h):
        peer = str(ipaddress.ip_address(h.client_address[0]))
        public = h.headers.get('Host') in {urlsplit(x).netloc for x in self.origins}
        if public and peer in self.proxy_ips:
            values = h.headers.get_all('CF-Connecting-IP',[])
            if len(values)!=1:raise AuthError('Ingress identity is missing or duplicated.',400)
            try:return str(ipaddress.ip_address(values[0]))
            except ValueError:raise AuthError('Ingress identity is invalid.',400) from None
        return peer
    def provider_config(self):
        with self.config_lock:
            if time.monotonic() >= self.config_until:
                self.public_config = self.accounts.provider.client_config()
                self.config_until = time.monotonic()+300
            return dict(self.public_config)
    def token(self, handler):
        def reject(category):
            logging.getLogger('echo.workspace.auth').debug(
                'workspace_session_cookie_rejected',
                extra={'schema_version':1, 'error_category':category})
            return ''
        headers = handler.headers
        values = headers.get_all('Cookie', []) if hasattr(headers, 'get_all') else [headers.get('Cookie', '')]
        if not values:return ''
        if len(values)!=1:return reject('duplicate_cookie_header')
        raw = values[0]
        if not isinstance(raw,str) or len(raw)>8192:return reject('cookie_header_limit')
        # Parse only our issued, unquoted name/value. Unrelated browser cookies
        # may contain JSON that whole-header SimpleCookie refuses to parse.
        token, found = '', False
        for segment in raw.split(';'):
            name, separator, value = segment.strip().partition('=')
            if name.strip()!='echo_workspace_session':continue
            if found:return reject('duplicate_session_cookie')
            found = True
            if name!='echo_workspace_session' or not separator or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}',value):
                return reject('invalid_session_cookie')
            token = value
        # Extraction is not admission: Accounts.resolve still checks the actual
        # process-local session, expiry, canonical identity and revocation.
        return token
    def session(self, handler):return self.accounts.resolve(self.token(handler))
    def cancel_session_requests(self, token, csrf):
        """Cancel only a locally validated session, including during issuer loss."""
        key = self.accounts.key(token)
        with self.accounts.lock:
            session = self.accounts.sessions.get(key)
            valid = (session and session['expires'] > time.time() and isinstance(csrf, str)
                     and secrets.compare_digest(csrf, session['csrf']))
        if valid:
            with self.lock:
                apps = [self.owner, *self.apps.values()]
            for app in apps:
                app.cancel_session(key)
    def application(self, user):
        if self.legacy_data_owner_uid is None:
            record(self.accounts.audit,operation='workspace_selection',status='unavailable',http_status=503,
                   error_category='storage_policy_unconfigured')
            raise AuthError('Private workspace storage is not configured.',503)
        if user['uid']==self.legacy_data_owner_uid:return self.owner
        key=self.accounts.key(user['uid'])
        with self.lock:
            if key not in self.apps:
                from app import Application
                config={k:copy.deepcopy(self.owner.config[k]) for k in ('model','model_url','context_length','model_providers') if k in self.owner.config}
                config['_tenant']=True
                config['tenant_id']=key
                self.apps[key]=Application(self.owner.store.root/'users'/key,config)
                record(self.accounts.audit,operation='tenant_workspace',status='created',tenant=key)
            return self.apps[key]
    def reply(self,h,value,status=200,cookie=None):
        if status >= 400:
            h.drain_rejected_body()
        data=json.dumps(value).encode()
        h.send_response(status)
        h.send_header('Content-Type','application/json; charset=utf-8')
        h.send_header('Cache-Control','no-store')
        h.send_header('X-Content-Type-Options','nosniff')
        h.send_header('Referrer-Policy','no-referrer')
        h.send_header('Content-Length',str(len(data)))
        if cookie is not None:
            secure = h.headers.get('Host') not in {f'127.0.0.1:{h.server.server_port}',f'localhost:{h.server.server_port}'}
            h.send_header('Set-Cookie','echo_workspace_session='+cookie+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+('28800' if cookie else '0')+('; Secure' if secure else ''))
        h.end_headers();h.wfile.write(data)
    def handle(self,h):
        path=urlsplit(h.path).path
        if h.command=='GET' and path in PUBLIC_FILES:
            name,kind=PUBLIC_FILES[path]
            data=(Path(__file__).parent/'static'/name).read_bytes()
            h.start(content_type=kind+'; charset=utf-8',length=len(data));h.wfile.write(data);return True
        if not path.startswith('/api/auth/'):return False
        try:
            local_logout = h.command=='POST' and path=='/api/auth/logout'
            session=None if local_logout else self.session(h)
            if h.command=='GET':
                if path=='/api/auth/session':
                    self.reply(h,{'authenticated':bool(session),'user':session['user'] if session else None,'csrf':session['csrf'] if session else None})
                elif path=='/api/auth/config':
                    self.reply(h,self.provider_config())
                elif path=='/api/auth/accounts' and session:
                    self.reply(h,{'accounts':self.accounts.pending(session['user'])})
                else:self.reply(h,{'error':'Not found'},404)
                return True
            if h.command!='POST':raise AuthError('Method not allowed.',405)
            if h.headers.get('Transfer-Encoding') or len(h.headers.get_all('Content-Length',[]))!=1:
                raise AuthError('Invalid body framing.',400)
            size=int(h.headers.get('Content-Length','0'))
            if not 0<size<=12000 or h.headers.get('Content-Type','').split(';')[0]!='application/json':
                raise AuthError('Send a small JSON object.',400)
            if h.headers.get('Origin') not in self.allowed_origins(h.server.server_port):
                raise AuthError('Untrusted request origin.',403)
            supplied=h.headers.get('X-Echo-CSRF','')
            if path in ('/api/auth/login','/api/auth/signup','/api/auth/reset'):
                if supplied!='login':raise AuthError('Reload the sign-in page.',403)
            elif not local_logout:
                if not session:raise AuthError('Sign in required.',401)
                if not secrets.compare_digest(supplied,session['csrf']):raise AuthError('Session check failed.',403)
            client_ip=self.client_ip(h)
            body=json.loads(h.read_body(size))
            if not isinstance(body,dict):raise AuthError('Expected an object.',400)
            if path=='/api/auth/login':
                token,user,csrf=self.accounts.login(body,client_ip)
                self.reply(h,{'user':user,'csrf':csrf},cookie=token)
            elif path=='/api/auth/signup':
                self.accounts.provider.signup(body,client_ip=client_ip)
                self.reply(h,{'message':'Check your email to verify your account, then sign in to request Workspace approval.'},202)
            elif path=='/api/auth/reset':
                self.accounts.provider.reset(body,client_ip=client_ip)
                self.reply(h,{'message':'If the account exists, a recovery email has been sent.'},202)
            elif path=='/api/auth/logout':
                token = self.token(h)
                self.cancel_session_requests(token, supplied)
                self.accounts.logout(token,csrf=supplied);self.reply(h,{'ok':True},cookie='')
            elif path=='/api/auth/decide':
                user = self.accounts.decide(session['user'],body.get('uid'),body.get('decision'))
                if user['status'] != 'approved':
                    with self.accounts.lock:
                        keys = [key for key, active in self.accounts.sessions.items() if active['uid'] == user['uid']]
                    with self.lock:
                        apps = [self.owner, *self.apps.values()]
                    for app in apps:
                        for key in keys:
                            app.cancel_session(key)
                self.reply(h,{'user':user})
            else:self.reply(h,{'error':'Not found'},404)
        except TimeoutError:
            h.close_connection=True
            self.reply(h,{'error':'Request body timed out.'},408)
        except AuthError as exc:self.reply(h,{'error':str(exc)},exc.status)
        except (ValueError,TypeError):self.reply(h,{'error':'Invalid request.'},400)
        except Exception as exc:
            record(self.accounts.audit,operation='auth_http',status='error',error_category=type(exc).__name__)
            self.reply(h,{'error':'Authentication is temporarily unavailable.'},503)
        return True
    def allowed_origins(self,port):
        return self.origins|{f'http://127.0.0.1:{port}',f'http://localhost:{port}'}
    def authorize(self,h):
        try:
            session=self.session(h)
            app=self.application(session['user']) if session and session['user']['status']=='approved' else None
        except AuthError as exc:
            self.reply(h,{'error':str(exc)},exc.status);return False
        if not session:
            if not urlsplit(h.path).path.startswith('/api/'):
                h.send_response(303);h.send_header('Location','/login');h.send_header('Cache-Control','no-store');h.send_header('Content-Length','0');h.end_headers()
            else:self.reply(h,{'error':'Sign in required.'},401)
            return False
        if session['user']['status']!='approved':
            self.reply(h,{'error':'Workspace access is '+session['user']['status']+'.','status':session['user']['status']},403);return False
        h.auth_session=session;h.request_app=app
        if app is not self.owner and urlsplit(h.path).path in ('/api/diagnostics','/api/plugins','/api/catalog','/api/fleet','/api/sync'):
            self.reply(h,{'error':'Owner capability is not available to this account.'},403);return False
        return True
