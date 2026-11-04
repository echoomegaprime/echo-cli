"""Per-account URL MCP connections with pinned public TLS endpoints and encrypted credentials."""
from contextlib import contextmanager
import ctypes
import hashlib
import http.client
import ipaddress
import json
import os
import re
import socket
import sqlite3
import ssl
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit
from workspace import WorkspaceError
from audit import record

class MCPError(WorkspaceError):pass

def hide_secret(value, token):
    if not token:return value
    if isinstance(value,str):return value.replace(token,'[REDACTED]')
    if isinstance(value,list):return [hide_secret(x,token) for x in value]
    if isinstance(value,dict):return {hide_secret(k,token):hide_secret(v,token) for k,v in value.items()}
    return value


def validate_url(value):
    if not isinstance(value,str) or len(value)>2048 or any(ord(c)<33 for c in value):
        raise MCPError('Enter a valid HTTPS MCP server URL.')
    p=urlsplit(value)
    try:port=p.port or 443
    except ValueError:raise MCPError('Invalid MCP port.') from None
    if p.scheme!='https' or not p.hostname or p.username or p.password or p.query or p.fragment or port!=443:
        raise MCPError('Use a public HTTPS URL on port 443 without credentials, query parameters or fragments.')
    host=p.hostname.lower()
    if host=='localhost' or host.endswith(('.localhost','.local','.internal')) or '%' in host:
        raise MCPError('Private network endpoints are not available through URL plugins.')
    try:
        if not ipaddress.ip_address(host).is_global:raise MCPError('Use a public MCP endpoint.')
    except ValueError:pass
    return p

def public_addresses(host,port):
    try:addresses=sorted({row[4][0] for row in socket.getaddrinfo(host,port,type=socket.SOCK_STREAM)})
    except OSError:raise MCPError('The MCP hostname could not be resolved.') from None
    if not addresses or any(not ipaddress.ip_address(x).is_global for x in addresses):
        raise MCPError('The MCP hostname resolves to a private or reserved address.')
    return addresses

class PinnedHTTPS(http.client.HTTPSConnection):
    def connect(self):
        # Resolve once and dial that exact validated address; TLS still verifies the original hostname.
        address=public_addresses(self.host,self.port)[0]
        raw=socket.create_connection((address,self.port),timeout=self.timeout)
        try:self.sock=self._context.wrap_socket(raw,server_hostname=self.host)
        except Exception:raw.close();raise

class WindowsCredentialCipher:
    def __init__(self,root):
        self.entropy=hashlib.sha256(str(Path(root).resolve()).encode()).digest()
    def crypt(self,value,decrypt):
        if os.name!='nt':raise MCPError('Credential storage requires the configured Windows credential protector.')
        class Blob(ctypes.Structure):
            _fields_=[('size',ctypes.c_ulong),('data',ctypes.POINTER(ctypes.c_ubyte))]
        def blob(data):
            buf=(ctypes.c_ubyte*len(data)).from_buffer_copy(data)
            return Blob(len(data),buf),buf
        source,source_buffer=blob(value);entropy,entropy_buffer=blob(self.entropy);result=Blob()
        crypt=ctypes.WinDLL('crypt32',use_last_error=True)
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.LocalFree.argtypes=[ctypes.c_void_p];kernel.LocalFree.restype=ctypes.c_void_p
        operation=crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
        operation.argtypes=[ctypes.POINTER(Blob),ctypes.c_void_p,ctypes.POINTER(Blob),ctypes.c_void_p,ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(Blob)]
        operation.restype=ctypes.c_int
        if not operation(ctypes.byref(source),None,ctypes.byref(entropy),None,None,1,ctypes.byref(result)):
            raise MCPError('Credential protection is unavailable.')
        try:return ctypes.string_at(result.data,result.size)
        finally:kernel.LocalFree(result.data)
    def seal(self,value):return self.crypt(value.encode(),False)
    def open(self,value):return self.crypt(value,True).decode()

class StreamableHTTP:
    versions={'2025-06-18','2025-03-26','2025-11-25'}
    def __init__(self,url,token=''):
        self.url,self.parsed,self.token=url,validate_url(url),token
        self.session=None;self.version='2025-06-18';self.serial=0;self.initialized=False
    @staticmethod
    def result(body,ident):
        if not isinstance(body,dict) or body.get('jsonrpc')!='2.0' or body.get('id')!=ident:
            raise MCPError('MCP returned an unexpected response.')
        if 'error' in body:raise MCPError('The MCP server rejected the request. No success was confirmed.')
        if 'result' not in body:raise MCPError('MCP returned no result.')
        return body['result']
    @staticmethod
    def decode_events(data,ident):
        try:text=data.decode('utf-8')
        except UnicodeDecodeError:raise MCPError('MCP stream has an incomplete UTF-8 event.') from None
        for event in text.replace('\r\n','\n').split('\n\n'):
            fields=[line[5:].lstrip() for line in event.split('\n') if line.startswith('data:')]
            if not fields:continue
            try:body=json.loads('\n'.join(fields))
            except ValueError:continue
            if isinstance(body,dict) and body.get('id')==ident:return StreamableHTTP.result(body,ident)
        raise MCPError('MCP stream ended without a matching result.')
    def request(self,body):
        connection=PinnedHTTPS(self.parsed.hostname,443,timeout=20,context=ssl.create_default_context())
        headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream',
                 'User-Agent':'EchoWorkspace-MCP/1.0','MCP-Protocol-Version':self.version}
        if self.token:headers['Authorization']='Bearer '+self.token
        if self.session:headers['Mcp-Session-Id']=self.session
        try:
            connection.request('POST',self.parsed.path or '/',json.dumps(body).encode(),headers)
            response=connection.getresponse()
            if response.status in (401,403):raise MCPError('MCP authentication was rejected. Check this connection’s token.')
            if response.status in (404,405):raise MCPError('Use this server’s Streamable HTTP MCP endpoint, usually ending in /mcp.')
            if response.status not in (200,202):raise MCPError('MCP connection failed (HTTP '+str(response.status)+').')
            sid=response.getheader('Mcp-Session-Id')
            if sid:
                if len(sid)>512 or not re.fullmatch(r'[\x21-\x7e]+',sid):raise MCPError('Invalid MCP session header.')
                self.session=sid
            if 'id' not in body:
                if response.status!=202:raise MCPError('MCP did not acknowledge initialization.')
                return {}
            kind=response.getheader('Content-Type','').split(';')[0]
            if kind not in ('application/json','text/event-stream'):raise MCPError('MCP returned an unsupported content type.')
            chunks=bytearray();deadline=time.monotonic()+25
            while len(chunks)<=524288 and time.monotonic()<deadline:
                chunk=response.read1(min(65536,524289-len(chunks)))
                if not chunk:break
                chunks.extend(chunk)
                if kind=='text/event-stream':
                    try:return self.decode_events(bytes(chunks),body['id'])
                    except MCPError:pass
            if len(chunks)>524288:raise MCPError('MCP response exceeded the size limit.')
            if time.monotonic()>=deadline:raise MCPError('MCP request timed out; check the service before retrying.')
            if kind=='text/event-stream':return self.decode_events(bytes(chunks),body['id'])
            return self.result(json.loads(chunks),body['id'])
        except MCPError:raise
        except (OSError,ValueError,http.client.HTTPException):
            raise MCPError('MCP connection failed or timed out. No success was confirmed; do not repeat a write without checking.') from None
        finally:connection.close()
    def rpc(self,method,params):
        self.serial+=1
        return self.request({'jsonrpc':'2.0','id':self.serial,'method':method,'params':params})
    def initialize(self):
        if self.initialized:return
        result=self.rpc('initialize',{'protocolVersion':self.version,'capabilities':{},'clientInfo':{'name':'EchoWorkspace','version':'1.0'}})
        if result.get('protocolVersion') not in self.versions:raise MCPError('This MCP protocol version is not supported.')
        self.version=result['protocolVersion']
        self.request({'jsonrpc':'2.0','method':'notifications/initialized'})
        self.initialized=True
    def discover(self):
        self.initialize();tools=[];cursor=None
        for _ in range(5):
            result=self.rpc('tools/list',{} if cursor is None else {'cursor':cursor})
            for tool in result.get('tools',[]):
                if not isinstance(tool,dict) or not re.fullmatch(r'[A-Za-z0-9_.:/-]{1,128}',str(tool.get('name',''))):raise MCPError('MCP supplied an invalid tool name.')
                schema=tool.get('inputSchema',{})
                if not isinstance(schema,dict) or schema.get('type')!='object' or len(json.dumps(schema))>16000:raise MCPError('MCP supplied an unsupported tool schema.')
                tools.append({'name':tool['name'],'description':str(tool.get('description',''))[:2000],'inputSchema':schema})
                if len(tools)>100:raise MCPError('This connection exceeds the 100-tool limit.')
            cursor=result.get('nextCursor')
            if not cursor:return tools
        raise MCPError('This connection has too many tool pages.')
    def call(self,name,args):
        self.initialize()
        return self.rpc('tools/call',{'name':name,'arguments':args})
    def close(self):
        # A session is not reused after this operation; no automatic retry of an action.
        self.initialized=False;self.session=None

class MCPConnections:
    def __init__(self,root,cipher=None,transport=None):
        self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True)
        self.path=self.root/'mcp.sqlite3';self.audit=self.root/'mcp-audit.jsonl'
        self.cipher=cipher or WindowsCredentialCipher(root);self.transport=transport or StreamableHTTP
        self.lock=threading.RLock()
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,auth TEXT NOT NULL,credential BLOB,enabled INTEGER NOT NULL,tools TEXT NOT NULL,checked REAL NOT NULL)')
    @contextmanager
    def db(self):
        db=sqlite3.connect(self.path,timeout=10);db.row_factory=sqlite3.Row
        try:
            with db:yield db
        finally:db.close()
    def row(self,ident):
        if not isinstance(ident,str) or not re.fullmatch('[a-f0-9]{32}',ident):raise MCPError('MCP connection not found.')
        with self.db() as db:r=db.execute('SELECT * FROM connections WHERE id=?',(ident,)).fetchone()
        if not r:raise MCPError('MCP connection not found.')
        return dict(r)
    @staticmethod
    def public(row):
        return {**{k:row[k] for k in ('id','name','url','auth','enabled','checked')},'tool_count':len(json.loads(row['tools']))}
    def list(self):
        with self.db() as db:return [self.public(dict(r)) for r in db.execute('SELECT * FROM connections ORDER BY name')]
    def add(self,body):
        url=str(body.get('url','')).strip();validate_url(url)
        name=str(body.get('name','')).strip()
        if not name or len(name)>80:raise MCPError('Name the MCP connection (up to 80 characters).')
        auth=body.get('auth','none');token=body.get('token','')
        if auth not in ('none','bearer') or not isinstance(token,str) or len(token)>8192 or any(ord(c)<33 or ord(c)>126 for c in token):
            raise MCPError('Choose no authentication or a valid bearer token.')
        if auth=='bearer' and not token:raise MCPError('Enter this MCP server’s bearer token.')
        if auth=='none':token=''
        credential=self.cipher.seal(token) if token else None
        client=self.transport(url,token)
        try:tools=client.discover()
        finally:client.close()
        # Remove a malicious server's credential echo before metadata can enter prompts or logs.
        encoded=json.dumps(hide_secret(tools,token))
        ident=uuid.uuid4().hex
        with self.lock,self.db() as db:
            if db.execute('SELECT count(*) FROM connections').fetchone()[0]>=20:raise MCPError('This account has reached its 20-connection limit.')
            db.execute('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?)',(ident,name,url,auth,credential,1,encoded,time.time()))
        record(self.audit,operation='mcp_add',status='connected',request_id=ident)
        return self.public(self.row(ident))
    def tools(self,ident):
        row=self.row(ident)
        return {'server':self.public(row),'tools':json.loads(row['tools']),'untrusted':True}
    def set_enabled(self,ident,enabled):
        self.row(ident)
        if not isinstance(enabled,bool):raise MCPError('Choose enabled or disabled.')
        with self.db() as db:db.execute('UPDATE connections SET enabled=? WHERE id=?',(int(enabled),ident))
        record(self.audit,operation='mcp_enable',status='enabled' if enabled else 'disabled',request_id=ident)
        return self.public(self.row(ident))
    def remove(self,ident):
        self.row(ident)
        with self.db() as db:
            db.execute('PRAGMA secure_delete=ON')
            db.execute('DELETE FROM connections WHERE id=?',(ident,))
        record(self.audit,operation='mcp_remove',status='removed',request_id=ident)
        return {'ok':True}
    def call(self,ident,name,args):
        row=self.row(ident)
        if not row['enabled']:raise MCPError('This MCP connection is disabled.')
        if name not in {t['name'] for t in json.loads(row['tools'])}:raise MCPError('Choose a discovered MCP tool.')
        if not isinstance(args,dict) or len(json.dumps(args))>64000:raise MCPError('MCP tool arguments must be a small JSON object.')
        token=self.cipher.open(row['credential']) if row['credential'] else ''
        client=self.transport(row['url'],token)
        try:
            result=client.call(name,args)
            result=hide_secret(result,token)
            record(self.audit,operation='mcp_call',status='tool_error' if result.get('isError') else 'received',request_id=ident,tool=name)
            return result
        except Exception:
            record(self.audit,operation='mcp_call',status='unconfirmed',request_id=ident,tool=name)
            raise
        finally:client.close()
