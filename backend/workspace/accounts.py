"""Workspace identity adapter and explicit per-user admission. No credential persistence."""
from __future__ import annotations
from contextlib import contextmanager
import hashlib
import ipaddress
import json
import math
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from audit import record
from approval_notifications import ApprovalNotifier

class AuthError(Exception):
    def __init__(self, message, status=403):
        super().__init__(message)
        self.status = status

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise AuthError('Identity service redirect rejected.', 503)

class IdentityClient:
    def __init__(self, base, google_client_id=None):
        parsed = urlsplit(base)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Identity service must use a fixed HTTPS origin.')
        if google_client_id is not None and (not isinstance(google_client_id,str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,256}',google_client_id)):
            raise ValueError('Configure a valid public Google client ID.')
        self.google_client_id = google_client_id
        self.base = base.rstrip('/')
        self.http = urllib.request.build_opener(NoRedirect)
    def request(self, path, body=None, bearer=None, client_ip=None):
        headers = {'User-Agent':'EchoWorkspace/1.0', 'Accept':'application/json'}
        if client_ip is not None: headers['X-Forwarded-For'] = str(ipaddress.ip_address(client_ip))
        if bearer: headers['Authorization'] = 'Bearer ' + bearer
        data = None if body is None else json.dumps(body).encode()
        if data is not None: headers['Content-Type'] = 'application/json'
        try:
            with self.http.open(urllib.request.Request(self.base + path, data=data, headers=headers), timeout=15) as response:
                raw = response.read(100001)
                if len(raw) > 100000: raise ValueError('oversized identity response')
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raise AuthError('Sign-in failed.' if exc.code in (400,401,403) else 'Identity service is unavailable.',
                            401 if exc.code in (400,401,403) else 503) from None
        except (OSError, ValueError):
            raise AuthError('Identity service is unavailable.',503) from None
    def login(self, body, client_ip=None):
        provider = body.get('provider','email')
        if provider == 'email':
            fields = {k:body.get(k,'') for k in ('email','password')}
            if not all(isinstance(v,str) and 0 < len(v) <= 1024 for v in fields.values()):
                raise AuthError('Enter your email and password.',400)
            return self.request('/v1/login',fields,client_ip=client_ip)
        if provider == 'google':
            return self.request('/v1/oauth/google',{'id_token':body.get('id_token',''),'token_type':body.get('token_type','google')},client_ip=client_ip)
        raise AuthError('Choose an available sign-in provider.',400)
    def verify(self, token):
        return self.request('/v1/verify',bearer=token)
    def refresh(self, token):
        return self.request('/v1/refresh',{'refresh_token':token})
    def logout(self, session):
        if session.get('refresh_token'):
            self.request('/v1/logout',{'refresh_token':session['refresh_token']})
    def signup(self, body, client_ip=None):
        return self.request('/v1/signup',{k:body.get(k,'') for k in ('email','password','display_name')},client_ip=client_ip)
    def reset(self, body, client_ip=None):
        return self.request('/v1/password/reset',{'email':body.get('email','')},client_ip=client_ip)
    def client_config(self):
        path = '/v1/client-config'
        if self.google_client_id: path += '?' + urlencode({'client_id':self.google_client_id})
        raw = self.request(path)
        if self.google_client_id and raw.get('google_client_id') != self.google_client_id:
            raise AuthError('Workspace Google sign-in is not configured in the identity service.',503)
        return {k:raw.get(k) for k in ('google_login_enabled','google_client_id','password_reset_enabled')}

class Accounts:
    def __init__(self, root, config, provider=None):
        self.root = Path(root)
        self.root.mkdir(parents=True,exist_ok=True)
        self.path = self.root / 'accounts.sqlite3'
        self.audit = self.root / 'authentication.jsonl'
        self.config = config
        self.owners = frozenset(config.get('owner_uids',[]))
        if not self.owners: raise ValueError('Configure verified owner identity IDs before enabling login.')
        self.provider = provider or IdentityClient(config.get('issuer','https://auth.echo-op.com'),google_client_id=config.get('google_client_id'))
        self.sessions, self.attempts = {}, {}
        self.lock = threading.RLock()
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS users(uid TEXT PRIMARY KEY,tenant TEXT UNIQUE NOT NULL,email TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS notifications(uid TEXT PRIMARY KEY,state TEXT NOT NULL DEFAULT "pending",attempts INTEGER NOT NULL DEFAULT 0,next_attempt REAL NOT NULL DEFAULT 0,receipt TEXT)')
    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path,timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db: yield db
        finally: db.close()
    @staticmethod
    def key(value): return hashlib.sha256(value.encode()).hexdigest()
    def user(self, uid):
        with self.db() as db:
            row = db.execute('SELECT * FROM users WHERE uid=?',(uid,)).fetchone()
            return dict(row) if row else None
    def admit_identity(self, identity):
        uid, email = identity.get('uid'), identity.get('email')
        if not isinstance(uid,str) or not re.fullmatch(r'[A-Za-z0-9_.:@-]{1,180}',uid) or identity.get('email_verified') is not True:
            raise AuthError('Verify your email with ECHO before signing in.',403)
        if not isinstance(email,str) or len(email)>320: raise AuthError('Identity verification failed.',401)
        owner = uid in self.owners
        ts = time.time()
        with self.db() as db:
            db.execute('INSERT OR IGNORE INTO users VALUES(?,?,?,?,?,?,?)',
                       (uid,self.key(uid),email,'owner' if owner else 'member','approved' if owner else 'pending',ts,ts))
            # Role comes only from the pinned identity mapping, never an email, token hint, or submitted body.
            db.execute('UPDATE users SET email=?,role=?,updated=? WHERE uid=?',(email,'owner' if owner else 'member',ts,uid))
            if owner: db.execute("UPDATE users SET status='approved' WHERE uid=?",(uid,))
            else: db.execute('INSERT OR IGNORE INTO notifications(uid) VALUES(?)',(uid,))
        return self.user(uid)
    def login(self, body, peer):
        now = time.time()
        account_key = 'account:' + self.key(str(body.get('email','')).strip().casefold()) if body.get('provider','email')=='email' else None
        peer_key = 'peer:' + self.key(str(peer))
        with self.lock:
            self.attempts = {k:[t for t in v if t>now-900] for k,v in self.attempts.items() if v and v[-1]>now-900}
            if (account_key and len(self.attempts.get(account_key,[]))>=10) or len(self.attempts.get(peer_key,[]))>=100 or len(self.attempts)>4096:
                raise AuthError('Too many attempts. Try again later.',429)
            if account_key:self.attempts.setdefault(account_key,[]).append(now)
            self.attempts.setdefault(peer_key,[]).append(now)
        try:
            credentials = dict(body)
            # An established user ID is also accepted; this does not alter the provider's credential check.
            if credentials.get('provider','email') == 'email' and '@' not in str(credentials.get('email','')):
                known = self.user(credentials.get('email',''))
                if known: credentials['email'] = known['email']
            upstream = self.provider.login(credentials,client_ip=peer)
            access = upstream.get('access_token')
            if not isinstance(access,str) or not access: raise AuthError('Sign-in did not return a verified session.',401)
            identity = self.provider.verify(access)
            user = self.admit_identity(identity)
            token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            with self.lock:
                self.sessions = {k:v for k,v in self.sessions.items() if v['expires']>now}
                if len(self.sessions)>=1024: raise AuthError('Session capacity reached. Try again later.',503)
                self.sessions[self.key(token)] = {'uid':user['uid'],'csrf':csrf,
                    'expires':now+min(86400,int(self.config.get('session_seconds',28800))),
                    'provider_expires':float(identity.get('exp',now+3600)), 'checked':now, 'refresh_lock':threading.Lock(),
                    'access_token':access,'refresh_token':upstream.get('refresh_token')}
            with self.lock:
                for key in (account_key,peer_key):
                    entries=self.attempts.get(key,[])
                    if now in entries:entries.remove(now)
            record(self.audit,operation='login',status='accepted',tenant=user['tenant'],admission=user['status'])
            return token, user, csrf
        except AuthError as exc:
            record(self.audit,operation='login',status='rejected',http_status=exc.status)
            raise
    def resolve(self, token):
        if not isinstance(token,str) or not 20<=len(token)<=120: return None
        key = self.key(token)
        with self.lock:
            session = self.sessions.get(key)
            if not session or session['expires']<=time.time():
                self.sessions.pop(key,None)
                return None
        # Serialize token rotation and verification only for this session. Never hold
        # the global session lock over issuer I/O or cache positive admission.
        with session['refresh_lock']:
            now = time.time()
            with self.lock:
                if self.sessions.get(key) is not session or session['expires']<=now:return None
            started = time.monotonic()
            refresh_attempted = False
            try:
                access, refresh = session['access_token'], session.get('refresh_token')
                if session['provider_expires']<=now+30:
                    if not session.get('refresh_token'): raise AuthError('Sign in again.',401)
                    # Even a failed response may follow consumption of a one-use
                    # refresh token. Never retry cached credentials after ambiguity.
                    refresh_attempted = True
                    refreshed = self.provider.refresh(session['refresh_token'])
                    if not isinstance(refreshed,dict) or not isinstance(refreshed.get('access_token'),str) or not refreshed['access_token']:
                        raise AuthError('Invalid refreshed session.',401)
                    access, refresh = refreshed['access_token'], refreshed.get('refresh_token')
                # IdentityClient preserves upstream JWT/signature/issuer/audience
                # validation and canonical enabled/existing-user checks.
                identity = self.provider.verify(access)
                if (not isinstance(identity,dict) or identity.get('uid') != session['uid']
                        or identity.get('email_verified') is not True
                        or not isinstance(identity.get('email'),str) or len(identity['email'])>320):
                    raise AuthError('Session identity changed.',401)
                try:expires = float(identity.get('exp',now+3600))
                except (TypeError,ValueError,OverflowError):raise AuthError('Invalid verified session.',401) from None
                if not math.isfinite(expires) or expires<=time.time():raise AuthError('Session expired.',401)
                with self.lock:
                    # Logout/expiry wins over even a successful late verify/refresh.
                    if self.sessions.get(key) is not session or session['expires']<=time.time():return None
                    session.update(access_token=access,refresh_token=refresh,provider_expires=expires,checked=time.time())
            except AuthError as exc:
                if exc.status in (400,401,403):
                    with self.lock:
                        if self.sessions.get(key) is session:self.sessions.pop(key,None)
                    record(self.audit,operation='session_verify',status='rejected',http_status=401,
                           duration_ms=round((time.monotonic()-started)*1000))
                    return None
                if refresh_attempted:
                    with self.lock:
                        if self.sessions.get(key) is session:self.sessions.pop(key,None)
                record(self.audit,operation='session_verify',status='unavailable',http_status=503,
                       error_category='refresh_unconfirmed' if refresh_attempted else 'issuer_unavailable',
                       duration_ms=round((time.monotonic()-started)*1000))
                raise AuthError('Identity service is temporarily unavailable.',503) from None
            except Exception:
                # Transport/driver details and identity payloads are never diagnostics.
                if refresh_attempted:
                    with self.lock:
                        if self.sessions.get(key) is session:self.sessions.pop(key,None)
                record(self.audit,operation='session_verify',status='unavailable',http_status=503,
                       error_category='refresh_unconfirmed' if refresh_attempted else 'issuer_unavailable',
                       duration_ms=round((time.monotonic()-started)*1000))
                raise AuthError('Identity service is temporarily unavailable.',503) from None
            record(self.audit,operation='session_verify',status='accepted',http_status=200,
                   duration_ms=round((time.monotonic()-started)*1000))
        # Local owner approval/denial remains current; verification never readmits
        # or updates a canonical user through admit_identity().
        user = self.user(session['uid'])
        with self.lock:
            if self.sessions.get(key) is not session or session['expires']<=time.time():return None
            return {'user':user,'csrf':session['csrf']} if user else None
    def logout(self, token, csrf=None):
        # The HTTP caller has already validated Origin/body framing. Only this
        # revocation path accepts local session evidence during issuer failure.
        key = self.key(token)
        with self.lock:
            session = self.sessions.get(key)
            if csrf is not None:
                if not session or session['expires']<=time.time():
                    self.sessions.pop(key,None)
                    raise AuthError('Sign in required.',401)
                if not isinstance(csrf,str) or not secrets.compare_digest(csrf,session['csrf']):
                    raise AuthError('Session check failed.',403)
            session = self.sessions.pop(key,None)
        if session:
            try:self.provider.logout(session)
            except Exception: pass
            record(self.audit,operation='logout',status='revoked')
    def decide(self, actor, uid, decision):
        # Re-read actor status; a stale role dict cannot carry authority after a change.
        current = self.user(actor.get('uid',''))
        if not current or current['uid'] not in self.owners or current['status']!='approved':
            raise AuthError('Owner approval required.',403)
        if uid in self.owners or decision not in ('approve','deny'): raise AuthError('Invalid account decision.',400)
        status = 'approved' if decision=='approve' else 'denied'
        with self.db() as db:
            cur = db.execute('UPDATE users SET status=?,updated=? WHERE uid=?',(status,time.time(),uid))
            if not cur.rowcount: raise AuthError('Account not found.',404)
        record(self.audit,operation='account_decision',status=status,tenant=self.key(uid),actor=self.key(current['uid']))
        return self.user(uid)
    def pending(self, actor):
        if actor.get('uid') not in self.owners: raise AuthError('Owner approval required.',403)
        with self.db() as db:
            return [dict(r) for r in db.execute("SELECT uid,tenant,email,role,status,created FROM users WHERE role!='owner' ORDER BY created DESC LIMIT 200")]
