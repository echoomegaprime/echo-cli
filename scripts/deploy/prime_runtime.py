"""Stage and supervise the reviewed QUENCH Prime release without exposing its backend.

Staging writes only the requested new directory. It does not install, start,
change ingress, copy authentication, migrate data, or create release approval.
Run requires separately pinned artifact and release-admission hashes. All
subprocesses use argument arrays, no shell, and no Windows console.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import ipaddress
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

PROTECTED_PORTS = {8768, 18767, 8771, 8772, 8781}
REQUIRED_ARTIFACTS = ('dist/code-main.js', 'package.json', 'package-lock.json', 'backend/workspace/app.py',
                      'backend/workspace/providers.py', 'backend/workspace/accounts.py',
                      'backend/workspace/accounts_http.py', 'backend/workspace/SOURCE_PROVENANCE.json',
                      'ui/echo-prime/index.html', 'ui/echo-prime/workspace.js', 'ui/echo-prime/models.js',
                      'scripts/deploy/prime_runtime.py', 'scripts/deploy/prime_runtimew.pyw')
_home_keys = {'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP',
              'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USERNAME',
              'LANG', 'LC_ALL', 'PROGRAMDATA', 'ProgramData', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME'}


def emit(event, **fields):
    print(json.dumps({'schema_version': 1, 'event': event, 'time_unix': round(time.time()), **fields}), flush=True)


def read_json(path, limit=8_000_000):
    with Path(path).open('rb') as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('JSON artifact exceeds its byte limit.')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError('Expected a JSON object.')
    return value


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def absolute(value):
    if not isinstance(value, str) or not value or any(c in value for c in '\0\r\n') or not Path(value).is_absolute():
        raise ValueError('An absolute reviewed path is required.')
    return Path(value)


def no_credentials(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if re.search(r'(?:password|secret|api.?key|bearer|access.?token|refresh.?token|oauth.?token)', key, re.I):
                raise ValueError('Use supported opaque authentication; literal credential fields cannot be staged.')
            no_credentials(child)
    elif isinstance(value, list):
        for child in value:
            no_credentials(child)


def validate_settings(value):
    value = json.loads(json.dumps(value))
    if value.get('schema_version') != 1 or not re.fullmatch(r'[a-f0-9]{40}', value.get('source_sha', '')):
        raise ValueError('An exact reviewed source SHA is required.')
    if value.get('public_origin') != 'https://echoomegaprime.com':
        raise ValueError('The canonical production origin must be https://echoomegaprime.com.')
    for field in ('release_root', 'data_root'):
        absolute(value.get(field))
    user = value.get('windows_user')
    if not isinstance(user, str) or not re.fullmatch(r'[^\\\r\n\0]{1,80}\\[^\\\r\n\0]{1,80}', user):
        raise ValueError('Pin the actual QUENCH Windows account with its existing CLI logins.')
    ports = value.get('ports', {})
    names = ('workspace', 'prime', 'qwen_tunnel', 'forge_forward', 'forge_proxy')
    if set(ports) != set(names) or any(type(ports[name]) is not int or not 1024 <= ports[name] <= 65535
                                    or ports[name] in PROTECTED_PORTS for name in names):
        raise ValueError('Provide measured, reserved, unprotected listener ports.')
    if len({ports[name] for name in ('workspace', 'prime', 'qwen_tunnel')}) != 3 or ports['forge_forward'] == ports['forge_proxy']:
        raise ValueError('Listener ports on the same node must be distinct.')
    executables = value.get('executables', {})
    if set(executables) != {'python', 'node', 'ssh'}:
        raise ValueError('Pin the reviewed native Python, Node and OpenSSH executables.')
    for executable in executables.values():
        if absolute(executable).suffix.lower() != '.exe':
            raise ValueError('Windows native executables are required; shell wrappers are refused.')
    ssh = value.get('ssh', {})
    try:
        host = ipaddress.ip_address(ssh.get('host', ''))
    except ValueError:
        raise ValueError('Pin the SDK-observed FORGE IP and existing SSH host-key binding.') from None
    if host.is_unspecified or host.is_multicast or host.is_loopback or not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', ssh.get('user', '')):
        raise ValueError('Invalid reviewed FORGE SSH endpoint.')
    absolute(ssh.get('identity_file'))
    absolute(ssh.get('known_hosts_file'))
    if type(ssh.get('qwen_remote_port')) is not int or not 1024 <= ssh['qwen_remote_port'] <= 65535:
        raise ValueError('Pin the measured existing FORGE Qwen endpoint port.')
    workspace, prime = value.get('workspace_config', {}), value.get('prime_config', {})
    if not isinstance(workspace, dict) or not isinstance(prime, dict):
        raise ValueError('Reviewed Workspace and Prime configuration objects are required.')
    auth = workspace.get('auth', {})
    owners = auth.get('owner_uids', [])
    legacy = auth.get('legacy_data_owner_uid')
    owner = prime.get('workspace', {}).get('ownerUid')
    if auth.get('enabled') is not True or auth.get('issuer') != 'https://auth.echo-op.com':
        raise ValueError('Canonical HTTPS account authentication must remain enabled.')
    if (not isinstance(owners, list) or not owners or any(not isinstance(uid, str) or not re.fullmatch(r'[A-Za-z0-9_.:@+-]{1,200}', uid) for uid in owners)
            or legacy not in owners or owner != legacy):
        raise ValueError('Pin the verified primary owner and explicit legacy data-owner mapping.')
    # The SSH reverse forward reaches the loopback-only Node listener from
    # loopback. This is a socket-peer allowlist, never an IP range or XFF trust.
    if prime.get('trustedIngressProxyIps') != ['127.0.0.1'] or auth.get('trusted_proxy_ips') != ['127.0.0.1']:
        raise ValueError('This topology requires the measured dedicated reverse-forward loopback peer.')
    if workspace.get('model') != 'c3po-code:echo-qwen38-abliterated-256k' or workspace.get('context_length') != 262144:
        raise ValueError('Qwen 3.8 on FORGE with the reviewed 262144-token context remains the default.')
    value['min_start_memory_mib'] = value.get('min_start_memory_mib', 2048)
    value['min_runtime_memory_mib'] = value.get('min_runtime_memory_mib', 1024)
    if (type(value['min_start_memory_mib']) is not int or value['min_start_memory_mib'] < 2048
            or type(value['min_runtime_memory_mib']) is not int or value['min_runtime_memory_mib'] < 1024):
        raise ValueError('Host memory floors cannot be reduced below the reviewed safety minimums.')
    no_credentials(workspace)
    no_credentials(prime)
    if workspace.get('sol_cli'):
        absolute(workspace['sol_cli'])
        if workspace.get('python') != executables['python']:
            raise ValueError('The configured scoped SDK must use the reviewed native Python executable.')
        mission = workspace.get('mission', {})
        if (not isinstance(mission, dict) or mission.get('enabled') is not True or mission.get('role') != 'builder'
                or not isinstance(mission.get('owner_session'), str)
                or not re.fullmatch(r'[A-Za-z0-9_.:@/-]{1,200}', mission['owner_session'])):
            raise ValueError('Configured SDK tools require the reviewed normal SOL mission bootstrap contract.')
        absolute(mission.get('state'))
        absolute(mission.get('workspace'))
    workspace['model_url'] = f'http://127.0.0.1:{ports["qwen_tunnel"]}'
    workspace['public_origins'] = [value['public_origin']]
    workspace['inference_timeout'] = 600
    prime['publicOrigin'] = value['public_origin']
    prime['workspace']['baseUrl'] = f'http://127.0.0.1:{ports["workspace"]}'
    return value


def artifact_manifest(root, source_sha):
    root = absolute(str(root)).resolve()
    files, total = [], 0
    for folder, directories, names in os.walk(root, followlinks=False):
        if '.git' in directories:
            raise ValueError('Use an acquired release artifact without a Git metadata directory.')
        for name in directories + names:
            if redirected_path(Path(folder) / name):
                raise ValueError('Release artifacts may not contain symlinks or junctions.')
        for name in names:
            path = Path(folder) / name
            size = path.stat().st_size
            total += size
            if len(files) >= 20000 or total > 2_000_000_000:
                raise ValueError('Release artifact exceeds the inventory budget.')
            files.append({'path': path.relative_to(root).as_posix(), 'sha256': sha256(path), 'bytes': size})
    manifest = {'schema_version': 1, 'source_sha': source_sha, 'files': sorted(files, key=lambda row: row['path'])}
    verify_artifact(root, manifest)
    return manifest


def redirected_path(path):
    return path.is_symlink() or bool(getattr(path, 'is_junction', lambda: False)())


def verify_artifact(root, manifest):
    root = absolute(str(root)).resolve()
    if manifest.get('schema_version') != 1 or not re.fullmatch(r'[a-f0-9]{40}', manifest.get('source_sha', '')):
        raise ValueError('Invalid exact-source artifact manifest.')
    rows = manifest.get('files')
    if not isinstance(rows, list) or not 1 <= len(rows) <= 20000:
        raise ValueError('Invalid artifact inventory.')
    seen = set()
    for row in rows:
        name = row.get('path', '')
        if (not isinstance(name, str) or not name or '\\' in name or Path(name).is_absolute()
                or any(part in ('', '.', '..') for part in name.split('/')) or name in seen):
            raise ValueError('Artifact paths must be unique safe relative paths.')
        path = root.joinpath(*name.split('/'))
        if not path.resolve().is_relative_to(root) or any(redirected_path(part) for part in (path, *path.parents)):
            raise ValueError('Artifact path escapes its reviewed root.')
        if not path.is_file() or path.stat().st_size != row.get('bytes') or sha256(path) != row.get('sha256'):
            raise ValueError('Artifact content is missing or changed.')
        seen.add(name)
    if not set(REQUIRED_ARTIFACTS).issubset(seen):
        raise ValueError('A required runtime artifact is absent from the manifest.')
    actual = set()
    for folder, directories, names in os.walk(root, followlinks=False):
        if '.git' in directories or any(redirected_path(Path(folder) / name) for name in directories + names):
            raise ValueError('Unexpected metadata or redirected artifact path.')
        for name in names:
            actual.add((Path(folder) / name).relative_to(root).as_posix())
            if len(actual) > 20000:
                raise ValueError('Release artifact exceeds the inventory budget.')
    if actual != seen:
        raise ValueError('Artifact inventory changed; unreviewed files cannot enter the runtime.')


def launch_plan(settings, stage):
    root, exe, ports, ssh = Path(settings['release_root']), settings['executables'], settings['ports'], settings['ssh']
    # No service command, shell script, model prompt or configuration contents
    # are interpolated into a shell. Existing SSH credentials stay in place.
    return {'workspace': [exe['python'], '-u', str(root / 'backend' / 'workspace' / 'app.py'),
                          '--data', settings['data_root'], '--config', str(stage / 'workspace.json'), '--port', str(ports['workspace'])],
            'prime': [exe['node'], str(root / 'dist' / 'code-main.js'), 'prime', '--config', str(stage / 'prime.json'),
                      '--port', str(ports['prime'])],
            'ssh': [exe['ssh'], '-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                    '-o', 'IdentitiesOnly=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
                    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
                    '-o', 'UserKnownHostsFile=' + ssh['known_hosts_file'], '-i', ssh['identity_file'],
                    '-R', f'127.0.0.1:{ports["forge_forward"]}:127.0.0.1:{ports["prime"]}',
                    '-L', f'127.0.0.1:{ports["qwen_tunnel"]}:127.0.0.1:{ssh["qwen_remote_port"]}',
                    ssh['user'] + '@' + ssh['host']]}


def forge_proxy(settings):
    ports = settings['ports']
    return f'''# Dedicated process configuration; never replace a shared nginx.conf.
worker_processes 1;
pid /run/echo-prime-domain-proxy.pid;
error_log /var/log/echo-prime/error.log warn;
events {{ worker_connections 128; }}
http {{
  log_format prime_metadata '$time_iso8601 status=$status duration=$request_time';
  access_log /var/log/echo-prime/access.log prime_metadata;
  server {{
    listen 127.0.0.1:{ports['forge_proxy']} default_server;
    server_name _;
    return 421;
  }}
  server {{
    listen 127.0.0.1:{ports['forge_proxy']};
    server_name www.echoomegaprime.com;
    return 308 https://echoomegaprime.com$request_uri;
  }}
  server {{
    listen 127.0.0.1:{ports['forge_proxy']};
    server_name echoomegaprime.com;
    client_max_body_size 2m;
    client_header_timeout 10s;
    client_body_timeout 25s;
    if ($http_cf_connecting_ip = "") {{ return 400; }}
    location / {{
      proxy_pass http://127.0.0.1:{ports['forge_forward']};
      proxy_http_version 1.1;
      proxy_set_header Host echoomegaprime.com;
      proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
      proxy_set_header Connection "";
      proxy_set_header Forwarded "";
      proxy_set_header X-Forwarded-For "";
      proxy_set_header X-Real-IP "";
      proxy_set_header X-Forwarded-Host "";
      proxy_set_header X-Forwarded-Proto "";
      proxy_connect_timeout 5s;
      proxy_send_timeout 30s;
      proxy_read_timeout 620s;
      proxy_buffering off;
      proxy_request_buffering on;
      proxy_ignore_client_abort off;
    }}
  }}
}}
'''


def stage(settings_path, output):
    settings = validate_settings(read_json(settings_path))
    output = absolute(str(output)).resolve()
    if output.exists():
        raise ValueError('Stage into a new directory; existing stages are immutable.')
    if output.is_relative_to(absolute(settings['release_root']).resolve()) or output.is_relative_to(absolute(settings['data_root']).resolve()):
        raise ValueError('Staging must stay outside source artifacts and private data.')
    manifest = artifact_manifest(settings['release_root'], settings['source_sha'])
    output.mkdir(parents=True, mode=0o700)
    if os.name == 'nt':
        # The directory is still empty. Remove inherited access before writing
        # any owner identifiers or runtime log paths, without copying a login.
        icacls = Path(os.environ['SystemRoot']) / 'System32' / 'icacls.exe'
        result = subprocess.run([str(icacls), str(output), '/inheritance:r', '/grant:r',
                                 settings['windows_user'] + ':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F'],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                shell=False, creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
        if result.returncode:
            raise ValueError('The private stage directory ACL could not be established.')
    for name, content in {'settings.json': settings, 'workspace.json': settings['workspace_config'],
                          'prime.json': settings['prime_config'], 'artifact-manifest.json': manifest,
                          'launch-plan.json': launch_plan(settings, output)}.items():
        path = output / name
        path.write_text(json.dumps(content, indent=2) + '\n', encoding='utf-8')
        path.chmod(0o600)
    (output / 'forge-nginx.conf').write_text(forge_proxy(settings), encoding='utf-8')
    emit('prime_stage_prepared', source_sha=settings['source_sha'], artifact_manifest_sha256=sha256(output / 'artifact-manifest.json'),
         settings_sha256=sha256(output / 'settings.json'), installed=False, started=False, approved=False)


class WindowsJob:
    """One owned job; closing it kills only this supervisor and descendants."""
    def __init__(self):
        if os.name != 'nt':
            raise ValueError('Production subscription runtime must run under its reviewed QUENCH Windows account.')
        from ctypes import wintypes
        class Basic(ctypes.Structure):
            _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong), ('PerJobUserTimeLimit', ctypes.c_longlong),
                        ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                        ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                        ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]
        class Counters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ('ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
                                                              'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]
        class Extended(ctypes.Structure):
            _fields_ = [('BasicLimitInformation', Basic), ('IoInfo', Counters), ('ProcessMemoryLimit', ctypes.c_size_t),
                        ('JobMemoryLimit', ctypes.c_size_t), ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.GetCurrentProcess.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = self.kernel.CreateJobObjectW(None, None)
        limits = Extended()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (not self.handle or not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits))
                or not self.kernel.AssignProcessToJobObject(self.handle, self.kernel.GetCurrentProcess())):
            raise OSError('An owned Windows process job could not be established.')

    def close(self):
        self.kernel.CloseHandle(self.handle)


def available_memory_mib():
    class MemoryStatus(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong),
                    *[(key, ctypes.c_ulonglong) for key in ('total_phys', 'avail_phys', 'total_page', 'avail_page',
                                                           'total_virtual', 'avail_virtual', 'avail_extended')]]
    status = MemoryStatus()
    status.length = ctypes.sizeof(status)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise OSError('Host memory measurement failed.')
    return status.avail_phys // (1024 * 1024)


def runtime_environment():
    env = {key: value for key, value in os.environ.items() if key in _home_keys}
    env.update(PYTHONUTF8='1', PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1',
               NODE_DEBUG='echo-prime-server,echo-prime-workspace')
    return env


def windows_identity():
    """Query the process access token's SAM identity, never environment labels."""
    from ctypes import wintypes
    security = ctypes.WinDLL('secur32', use_last_error=True)
    lookup = security.GetUserNameExW
    lookup.argtypes = [ctypes.c_int, wintypes.LPWSTR, ctypes.POINTER(wintypes.ULONG)]
    lookup.restype = ctypes.c_ubyte
    size = wintypes.ULONG(1024)
    value = ctypes.create_unicode_buffer(size.value)
    if not lookup(2, value, ctypes.byref(size)) or not value.value or '\\' not in value.value:
        raise OSError('The Windows process identity could not be verified from its token.')
    return value.value


def validate_runtime_identity(expected):
    if windows_identity().casefold() != expected.casefold():
        raise ValueError('Use the pinned Windows account; subscription homes must not be copied or substituted.')


def validate_source_binding(settings, manifest, admission):
    selected = settings.get('source_sha')
    if not selected or manifest.get('source_sha') != selected or admission.get('source_sha') != selected:
        raise ValueError('Artifact, runtime settings and admission evidence must name the same exact source SHA.')


def verify_scoped_mission(settings):
    workspace = settings['workspace_config']
    if not workspace.get('sol_cli'):
        return
    options = workspace['mission']
    identity = read_json(Path(settings['data_root']) / 'sol-mission.json', limit=65536)
    run_id = identity.get('run_id')
    if (not isinstance(run_id, str) or not re.fullmatch(r'sol-[A-Za-z0-9_-]{1,120}', run_id)
            or identity.get('role') != options['role']
            or not re.fullmatch(r'[a-f0-9]{64}', identity.get('token_hash', ''))):
        raise ValueError('The owned Workspace mission has no completed scoped-token metadata.')
    result = subprocess.run([workspace['python'], workspace['sol_cli'], '--state', options['state'],
                             'mission', 'show', run_id],
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding='utf-8',
                            env=runtime_environment(), timeout=20, shell=False,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode or len(result.stdout.encode('utf-8')) > 131072:
        raise ValueError('The normal installed SOL mission metadata read failed.')
    try:
        live = json.loads(result.stdout)
    except ValueError:
        raise ValueError('The normal SOL mission metadata response is invalid.') from None
    if (not isinstance(live, dict) or live.get('run_id') != run_id or live.get('role') != options['role']
            or not isinstance(live.get('workspace'), str)
            or Path(live['workspace']).resolve() != Path(options['workspace']).resolve()
            or live.get('status') not in ('running', 'verifying')
            or live.get('pause_requested') not in (False, 0) or live.get('halt_requested') not in (False, 0)):
        raise ValueError('The owned Workspace SOL mission is not live in the reviewed role and workspace.')
    # This is startup metadata admission, not token authority issuance. Existing
    # Mission.ensure checks actual token revocation/expiry on each SDK dispatch.
    emit('prime_scoped_mission_ready', run_id=run_id, role=options['role'], status=live['status'])


def wait_http(port, path, host, child, timeout=30, public=False):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError('An owned runtime exited during startup.')
        try:
            headers = {'Host': host}
            if public:
                # Strictly loopback startup probe, never a public user identity.
                headers['CF-Connecting-IP'] = '127.0.0.1'
            request = urllib.request.Request(f'http://127.0.0.1:{port}{path}', headers=headers)
            with urllib.request.urlopen(request, timeout=2) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        time.sleep(0.2)
    raise RuntimeError('Bounded loopback startup probe failed.')


def run(stage_root, manifest_hash, settings_hash, admission_path, admission_hash):
    stage_root = absolute(str(stage_root)).resolve()
    # OS file locking releases automatically on hard crash. A stale PID does
    # not authorize killing any process or bypassing ownership.
    import msvcrt
    instance_lock = (stage_root / 'supervisor.lock').open('a+b')
    instance_lock.seek(0)
    if not instance_lock.read(1):
        instance_lock.write(b'1')
        instance_lock.flush()
    instance_lock.seek(0)
    try:
        msvcrt.locking(instance_lock.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        instance_lock.close()
        raise RuntimeError('This exact stage already has an owned supervisor.') from None
    try:
        return _run_locked(stage_root, manifest_hash, settings_hash, admission_path, admission_hash)
    finally:
        instance_lock.close()


def prepare_task(stage_root, manifest_hash, settings_hash, admission_path, admission_hash, output):
    """Prepare an unregistered task definition, with no password or elevation."""
    stage_root, admission_path = absolute(str(stage_root)).resolve(), absolute(str(admission_path)).resolve()
    for path, expected in ((stage_root / 'artifact-manifest.json', manifest_hash), (stage_root / 'settings.json', settings_hash),
                           (admission_path, admission_hash)):
        if not re.fullmatch(r'[a-f0-9]{64}', expected) or sha256(path) != expected:
            raise ValueError('Pinned deployment artifact or admission evidence changed.')
    settings = validate_settings(read_json(stage_root / 'settings.json'))
    manifest = read_json(stage_root / 'artifact-manifest.json')
    validate_source_binding(settings, manifest, read_json(admission_path))
    verify_artifact(settings['release_root'], manifest)
    executable = Path(settings['executables']['python']).with_name('pythonw.exe')
    if not executable.is_file():
        raise ValueError('The matching windowless Python executable is unavailable.')
    script = Path(settings['release_root']) / 'scripts' / 'deploy' / 'prime_runtimew.pyw'
    args = [str(script), 'run', '--stage', str(stage_root), '--manifest-sha256', manifest_hash,
            '--settings-sha256', settings_hash, '--admission', str(admission_path), '--admission-sha256', admission_hash]
    ns = 'http://schemas.microsoft.com/windows/2004/02/mit/task'
    ET.register_namespace('', ns)
    def add(parent, name, text=None, **attributes):
        child = ET.SubElement(parent, '{' + ns + '}' + name, attributes)
        if text is not None: child.text = text
        return child
    task = ET.Element('{' + ns + '}Task', {'version': '1.3'})
    info = add(task, 'RegistrationInfo')
    add(info, 'Description', 'Exact-source ECHO Prime supervisor; private existing subscription login account; owned job only.')
    triggers = add(task, 'Triggers')
    logon = add(triggers, 'LogonTrigger')
    add(logon, 'Enabled', 'true')
    add(logon, 'UserId', settings['windows_user'])
    principal = add(add(task, 'Principals'), 'Principal', id='PrimeOwner')
    add(principal, 'UserId', settings['windows_user'])
    add(principal, 'LogonType', 'InteractiveToken')
    add(principal, 'RunLevel', 'LeastPrivilege')
    task_settings = add(task, 'Settings')
    for name, value in (('MultipleInstancesPolicy', 'IgnoreNew'), ('DisallowStartIfOnBatteries', 'false'),
                        ('StopIfGoingOnBatteries', 'false'), ('AllowHardTerminate', 'true'),
                        ('StartWhenAvailable', 'false'), ('Enabled', 'true'), ('Hidden', 'true'),
                        ('ExecutionTimeLimit', 'PT0S')):
        add(task_settings, name, value)
    execute = add(add(task, 'Actions', Context='PrimeOwner'), 'Exec')
    add(execute, 'Command', str(executable))
    add(execute, 'Arguments', subprocess.list2cmdline(args))
    add(execute, 'WorkingDirectory', settings['release_root'])
    destination = absolute(str(output))
    with destination.open('xb') as stream:
        stream.write(ET.tostring(task, encoding='utf-16', xml_declaration=True))
    emit('prime_task_prepared', source_sha=settings['source_sha'], task_sha256=sha256(destination),
         installed=False, started=False, automatic_restart=False)


def _run_locked(stage_root, manifest_hash, settings_hash, admission_path, admission_hash):
    for path, expected in ((stage_root / 'artifact-manifest.json', manifest_hash), (stage_root / 'settings.json', settings_hash),
                           (absolute(str(admission_path)), admission_hash)):
        if not re.fullmatch(r'[a-f0-9]{64}', expected) or sha256(path) != expected:
            raise ValueError('Pinned deployment artifact or admission evidence changed.')
    settings = validate_settings(read_json(stage_root / 'settings.json'))
    admission = read_json(admission_path)
    manifest = read_json(stage_root / 'artifact-manifest.json')
    validate_source_binding(settings, manifest, admission)
    # Receipt semantics remain with Echo Preflight / CertForge and the parent
    # release authority. This binds the actual reviewed receipt bytes; it never
    # manufactures a certification, environment digest, or approval.
    verify_artifact(settings['release_root'], manifest)
    for name, expected in (('workspace.json', settings['workspace_config']), ('prime.json', settings['prime_config'])):
        if read_json(stage_root / name) != expected:
            raise ValueError('Generated runtime configuration changed after staging.')
    validate_runtime_identity(settings['windows_user'])
    for path in [*settings['executables'].values(), settings['ssh']['identity_file'], settings['ssh']['known_hosts_file']]:
        if not absolute(path).is_file():
            raise ValueError('A reviewed native executable or existing SSH identity binding is unavailable.')
    if available_memory_mib() < settings['min_start_memory_mib']:
        raise RuntimeError('Host memory is below the reviewed startup floor.')
    for key in ('workspace', 'prime', 'qwen_tunnel'):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', settings['ports'][key]))
    stop = threading.Event()
    for code in (signal.SIGINT, signal.SIGTERM):
        signal.signal(code, lambda *_: stop.set())
    stop_path = stage_root / 'stop.request'
    if stop_path.exists():
        raise RuntimeError('A stop request is present; do not restart an intentionally stopped stage.')
    job, children, logs = WindowsJob(), {}, []
    try:
        plan = launch_plan(settings, stage_root)
        for name in ('ssh', 'workspace', 'prime'):
            stdout, stderr = (stage_root / f'{name}.{stream}.log' for stream in ('stdout', 'stderr'))
            handles = [stdout.open('ab', buffering=0), stderr.open('ab', buffering=0)]
            logs.extend(handles)
            children[name] = subprocess.Popen(plan[name], cwd=settings['release_root'], env=runtime_environment(),
                                              stdin=subprocess.DEVNULL, stdout=handles[0], stderr=handles[1],
                                              shell=False, creationflags=subprocess.CREATE_NO_WINDOW)
            emit('prime_owned_process_started', component=name, pid=children[name].pid)
            if name == 'ssh':
                time.sleep(1)
                if children[name].poll() is not None:
                    raise RuntimeError('The dedicated SSH forward could not start.')
            elif name == 'workspace':
                port = settings['ports']['workspace']
                wait_http(port, '/api/auth/session', f'127.0.0.1:{port}', children[name],
                          timeout=300 if settings['workspace_config'].get('sol_cli') else 30)
                verify_scoped_mission(settings)
            else:
                wait_http(settings['ports']['prime'], '/', 'echoomegaprime.com', children[name], public=True)
        emit('prime_runtime_started', source_sha=settings['source_sha'], public_acceptance=False)
        while not stop.wait(2):
            if stop_path.exists():
                emit('prime_runtime_stopping', reason='owned_stop_request')
                break
            exited = next((name for name, child in children.items() if child.poll() is not None), None)
            if exited:
                raise RuntimeError('An owned runtime dependency exited.')
            available = available_memory_mib()
            if available < settings['min_runtime_memory_mib']:
                emit('prime_runtime_stopping', reason='host_memory_floor', available_memory_mib=available)
                break
    finally:
        emit('prime_runtime_stopping', reason='supervisor_exit', owned_components=list(children))
        for child in children.values():
            if child.poll() is None:
                child.terminate()
        for child in children.values():
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass  # The owned Windows job closes all remaining descendants.
        for handle in logs:
            handle.close()
        sys.stdout.flush()
        job.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prepare = commands.add_parser('stage')
    prepare.add_argument('--settings', required=True)
    prepare.add_argument('--output', required=True)
    launch = commands.add_parser('run')
    launch.add_argument('--stage', required=True)
    launch.add_argument('--manifest-sha256', required=True)
    launch.add_argument('--settings-sha256', required=True)
    launch.add_argument('--admission', required=True)
    launch.add_argument('--admission-sha256', required=True)
    task = commands.add_parser('task')
    task.add_argument('--stage', required=True)
    task.add_argument('--manifest-sha256', required=True)
    task.add_argument('--settings-sha256', required=True)
    task.add_argument('--admission', required=True)
    task.add_argument('--admission-sha256', required=True)
    task.add_argument('--output', required=True)
    stop = commands.add_parser('stop')
    stop.add_argument('--stage', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'stage':
            stage(args.settings, args.output)
        elif args.command == 'run':
            run(args.stage, args.manifest_sha256, args.settings_sha256, args.admission, args.admission_sha256)
        elif args.command == 'task':
            prepare_task(args.stage, args.manifest_sha256, args.settings_sha256, args.admission, args.admission_sha256, args.output)
        else:
            target = absolute(args.stage).resolve()
            read_json(target / 'settings.json')
            (target / 'stop.request').touch(exist_ok=True)
            emit('prime_owned_stop_requested')
    except Exception as error:
        # Do not print raw configuration, argv, identities, driver failures,
        # OAuth material, or exception strings that may contain those values.
        emit('prime_deployment_failed', category=type(error).__name__)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
