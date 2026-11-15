"""Existing, role-scoped transports only. No credential copying or scope issuance."""
from __future__ import annotations

import json
import http.client
import io
import logging
import os
import queue
import re
import select
import subprocess
import socket
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from contextlib import contextmanager

from workspace import WorkspaceError, redact, verify_capture, capture_event, now
from audit import record
from providers import ProviderCancelledError, ProviderUnavailableError, canonical_tool_message

_qwen_locks, _qwen_locks_guard = {}, threading.Lock()
_model_log = logging.getLogger('echo.workspace.model')


def _qwen_check(cancel_event):
    if cancel_event is not None and cancel_event.is_set():
        raise ProviderCancelledError('qwen')


@contextmanager
def _qwen_open(request, timeout, cancel_event=None):
    _qwen_check(cancel_event)
    if cancel_event is None:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            yield response
        return
    # urllib's usual urlopen does not expose its socket until headers return.
    # Capture the socket at connect time so cancelling a long prefill/header wait
    # shuts down only this request. Ollama receives the client disconnect; no
    # shared model unload or service/container operation is issued.
    owned_socket, owned_readers, stopped = [], [], threading.Event()
    began = time.monotonic()

    def trace(stage, **fields):
        _model_log.debug(json.dumps({'schemaVersion': 1, 'event': 'qwen_transport_trace', 'stage': stage,
                                     'elapsed_ms': round((time.monotonic() - began) * 1000), **fields}))

    def shutdown():
        for active in owned_socket:
            try:
                trace('shutdown_begin', fd=active.fileno())
                active.shutdown(socket.SHUT_RDWR)
                trace('shutdown_returned', fd=active.fileno())
            except OSError as error:
                _model_log.debug(json.dumps({'schemaVersion': 1, 'event': 'qwen_cancel_socket',
                                             'outcome': 'already_closed', 'errno': error.errno}))

    class PollingReader(io.RawIOBase):
        def __init__(self, active):
            super().__init__()
            self.active = active.dup()
            owned_readers.append(self)

        def readable(self):
            return True

        def readinto(self, target):
            # A Windows buffered recv already pending when another descriptor
            # calls shutdown can remain blocked. Poll BEFORE each recv instead
            # of using read timeouts, which invalidate BufferedReader state.
            while True:
                _qwen_check(cancel_event)
                remaining = began + timeout - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Qwen request deadline exceeded')
                ready, _, _ = select.select([self.active], [], [], min(0.1, remaining))
                if not ready:
                    continue
                _qwen_check(cancel_event)
                return self.active.recv_into(target)

        def close(self):
            if not self.closed:
                self.active.close()
            super().close()

    class SocketView:
        def __init__(self, active):
            self.active = active

        def makefile(self, mode, *args, **kwargs):
            if mode != 'rb':
                raise ValueError('Only bounded response reads are supported')
            return io.BufferedReader(PollingReader(self.active))

    class Response(http.client.HTTPResponse):
        def __init__(self, active, *args, **kwargs):
            super().__init__(SocketView(active), *args, **kwargs)

    class Connection(http.client.HTTPConnection):
        response_class = Response

        def connect(self):
            trace('connect_begin')
            super().connect()
            # urllib closes/detaches HTTPConnection.sock once response headers
            # have been parsed. Keep a separate owned descriptor for shutdown;
            # retaining the original Python wrapper races that transition.
            owned_socket.append(self.sock.dup())
            trace('connected', original_fd=self.sock.fileno(), owned_fd=owned_socket[-1].fileno())
            self.sock.settimeout(min(5, timeout))
            if cancel_event.is_set():
                shutdown()
                raise ProviderCancelledError('qwen')

    class Handler(urllib.request.HTTPHandler):
        def http_open(self, req):
            return self.do_open(lambda host, **options: Connection(host, timeout=min(5, timeout)), req)

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    def watch():
        trace('watch_started')
        while not stopped.wait(0.05):
            if cancel_event.is_set():
                trace('cancel_observed', socket_count=len(owned_socket))
                shutdown()
                return

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Handler(), NoRedirect())
        trace('open_begin')
        with opener.open(request, timeout=min(5, timeout)) as response:
            trace('response_opened')
            _qwen_check(cancel_event)
            yield response
            trace('caller_read_returned')
            _qwen_check(cancel_event)
    except (OSError, ValueError, http.client.HTTPException):
        _qwen_check(cancel_event)
        raise
    finally:
        trace('cleanup_begin', cancelled=cancel_event.is_set())
        stopped.set()
        if cancel_event.is_set():
            shutdown()
        watcher.join(timeout=0.2)
        for active in owned_socket:
            active.close()
        for reader in owned_readers:
            reader.close()
        trace('cleanup_returned')


def unpack(result, preserve_esh_receipt=False):
    for _ in range(12):
        if not isinstance(result, dict):
            return result
        if preserve_esh_receipt and result.get('envelope_version') == 1 and 'verdict' in result:
            return result  # Preserve failed/gated execution evidence without treating it as success.
        if result.get('isError') is True:
            raise WorkspaceError('Connector reported a tool error; its payload is not success evidence.')
        if result.get('error') or result.get('blocked') or result.get('ok') is False:
            reason = result.get('error') or result.get('reason') or 'Operation blocked'
            raise WorkspaceError(redact(str(reason))[:600])
        if isinstance(result.get('structuredContent'), dict):
            result = result['structuredContent']
            continue
        if 'content' in result and isinstance(result['content'], list):
            first = next((b.get('text') for b in result['content'] if b.get('type') == 'text'), '{}')
            try:
                result = json.loads(first)
                continue
            except (ValueError, TypeError):
                if result.get('isError'):
                    raise WorkspaceError('Connector rejected the operation.')
                return {'text': redact(str(first))}
        nested = next((result[k] for k in ('structuredContent', 'sdk_result', 'result', 'body') if isinstance(result.get(k), dict)), None)
        if nested is None:
            return result
        result = nested
    raise WorkspaceError('Unexpected connector response.')


def sanitized(value):
    if isinstance(value, dict):
        return {k: ('[REDACTED]' if re.search(r'(?i)(secret|password|token|api.?key|authorization|private.?key)', k)
                    else sanitized(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitized(v) for v in value]
    return redact(value) if isinstance(value, str) else value


class Stdio:
    def __init__(self, config):
        self.config, self.lock = config, threading.Lock()
        self.proc = None
        self.serial = 0

    def _start(self):
        if self.proc and self.proc.poll() is None:
            return
        self.output = queue.Queue()
        self.proc = subprocess.Popen([self.config['command'], *self.config.get('args', [])],
            cwd=self.config.get('cwd'), env={**os.environ, **self.config.get('env', {})},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding='utf-8', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        proc, output = self.proc, self.output
        def reader():
            try:
                for line in proc.stdout:
                    try:
                        output.put(json.loads(line))
                    except ValueError:
                        continue
            finally:
                output.put({'transport_closed': True})
        threading.Thread(target=reader, daemon=True).start()
        self._rpc('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                  'clientInfo': {'name': 'echo-qwen-workspace', 'version': '0.1.0'}}, 20)
        self.proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n')
        self.proc.stdin.flush()

    def _rpc(self, method, params, timeout):
        self.serial += 1
        request_id = self.serial
        self.proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params}) + '\n')
        self.proc.stdin.flush()
        import time
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                reply = self.output.get(timeout=max(.01, deadline - time.monotonic()))
            except queue.Empty:
                raise WorkspaceError('Connector timed out; check the receipt before retrying an action.') from None
            if reply.get('transport_closed'):
                raise WorkspaceError('Connector process stopped.')
            if reply.get('id') == request_id:
                if reply.get('error'):
                    raise WorkspaceError('Connector rejected the request schema.')
                return reply.get('result', {})
        raise WorkspaceError('Connector timed out.')

    def call(self, name, args):
        with self.lock:
            self._start()
            return unpack(self._rpc('tools/call', {'name': name, 'arguments': args}, 90), preserve_esh_receipt=name in ('esh_run', 'esh_verb'))

    def close(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()


class Bridges:
    def __init__(self, config, mission=None):
        self.config = config
        self.mission = mission
        self.clients = {}
        self.lock = threading.Lock()

    def call(self, plugin, tool, args):
        if self.config.get('_tenant'):
            raise WorkspaceError('This account has no global connector access.')
        allowed = {'ecf': {'continuity_status', 'continuity_recall', 'continuity_capture'},
                   'crystal': {'crystal_status', 'crystal_recall', 'crystal_store', 'crystal_get'},
                   'esh': {'esh_status', 'esh_ledger', 'esh_run', 'esh_verb'},
                   'personality': {'echo_personality_gateway_health', 'echo_personality_get_conversation_defaults',
                       'echo_personality_start_progressive_synthesis', 'echo_personality_next_progressive_chunk',
                       'echo_personality_prepare_speech', 'echo_personality_list_assets'}}
        if tool not in allowed.get(plugin, set()):
            raise WorkspaceError('This connector action is not exposed.')
        if plugin == 'ecf' and self.config.get('sol_cli'):
            # Same Fabric routes, through the workspace's renewable SOL mission.
            command = tool.removeprefix('continuity_')
            options = dict(args)
            options.pop('limit', None)  # Current Fabric schema accepts query only.
            return self.sdk('echo.continuity.' + command, command, options)
        with self.lock:
            if plugin not in self.clients:
                config = self.config.get('plugins', {}).get(plugin)
                if not config:
                    raise WorkspaceError(f'{plugin} is not configured.')
                self.clients[plugin] = Stdio(config)
            client = self.clients[plugin]
        return sanitized(client.call(tool, args))

    def sdk(self, capability, command, options):
        if self.config.get('_tenant'):
            raise WorkspaceError('This account has no owner SDK or global memory access.')
        started = time.monotonic()
        try:
            result = self._sdk(capability, command, options)
            record(self.config.get('audit_path'), operation='sdk', capability=capability, command=command,
                   status='returned', duration_ms=round((time.monotonic() - started) * 1000), run_id=os.getenv('SOL_RUN_ID'))
            return result
        except Exception as exc:
            record(self.config.get('audit_path'), operation='sdk', capability=capability, command=command,
                   status='error', error_category=type(exc).__name__, duration_ms=round((time.monotonic() - started) * 1000), run_id=os.getenv('SOL_RUN_ID'))
            raise

    def _sdk(self, capability, command, options):
        if self.mission:
            self.mission.ensure()
        if not os.environ.get('SOL_BROKER_TOKEN') or not os.environ.get('SOL_STATE_DB'):
            raise WorkspaceError('No SOL mission scope. Launch this workspace through an authorized SOL session.')
        if not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_-]*\.[a-zA-Z0-9_.-]{1,160}', capability) or not re.fullmatch(r'[a-zA-Z0-9_.-]{1,60}', command):
            raise WorkspaceError('Invalid SDK capability or command.')
        cli = self.config.get('sol_cli')
        if not cli:
            raise WorkspaceError('Scoped SDK adapter is not configured.')
        # The broker owns params.command ("exec"). The node router expects its
        # shell command inside params.options, a separate documented payload.
        if capability == 'echo.node.exec' and 'command' in options:
            options = {'options': options}
        # stdin, never argv or a plaintext temporary file. Helper calls main(),
        # not the CLI entrypoint that may issue a replacement token after expiry.
        proc = subprocess.run([self.config.get('python', 'python'),
            str(Path(__file__).with_name('sdk_dispatch.py')), '--runtime', str(Path(cli).parent),
            '--capability', capability, '--command', command, '--options-file', '-'],
            input=json.dumps(options), capture_output=True, text=True, encoding='utf-8', timeout=95,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if proc.returncode:
            try:
                category = json.loads(proc.stderr).get('error', 'Scoped SDK operation failed')
            except ValueError:
                category = 'Scoped SDK operation failed; see the mission audit.'
            raise WorkspaceError(redact(str(category))[:600])
        return sanitized(unpack(json.loads(proc.stdout)))

    def vault(self, action, args):
        if action not in ('health', 'list', 'get', 'put', 'locate'):
            raise WorkspaceError('Unsupported Vault action.')
        result = self.sdk('echo.vault.' + action, action, args)
        # No secret value reaches HTTP, journals, or the model, including on success.
        keys = ('ok', 'stored', 'service', 'username', 'version', 'created_at', 'updated_at',
                'access_count', 'tags', 'status', 'count', 'master_key_loaded', 'db_reachable')
        if action == 'list':
            rows = result.get('credentials', result.get('items', result.get('entries', [])))
            return {'entries': [{k: r[k] for k in keys if k in r} for r in rows if isinstance(r, dict)], 'count': len(rows)}
        projected = {k: result[k] for k in keys if k in result}
        projected['operation'] = action
        if action == 'get':
            projected['note'] = 'Scoped retrieval returned. Secret values remain inside the governed broker; use the service/account reference with a supported Echo connector.'
        return projected

    def close(self):
        for c in self.clients.values():
            c.close()


class Model:
    def __init__(self, base_url, model, context_length=262144):
        from urllib.parse import urlparse
        parsed = urlparse(base_url)
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise WorkspaceError('The model must use a loopback endpoint or the private SSH tunnel.')
        self.base, self.model = base_url.rstrip('/'), model
        if type(context_length) is not int or context_length not in (32768, 65536, 131072, 262144):
            raise WorkspaceError('Choose a supported context profile.')
        self.context_length = context_length
        self.last_usage = {}
        self.last_identity = None
        # All tenant applications addressing this loopback tunnel share the same
        # inference admission. Conservative host normalization also joins the
        # localhost/IPv4/IPv6 spellings of one configured endpoint.
        key = (parsed.port or 80, parsed.path.rstrip('/'))
        with _qwen_locks_guard:
            self.lock = _qwen_locks.setdefault(key, threading.Lock())

    def status(self, cancel_event=None):
        try:
            with _qwen_open(self.base + '/api/ps', 5, cancel_event) as r:
                result = json.load(r)
            models = result.get('models', [])
            current = next((m for m in models if m.get('name', m.get('model')) == self.model), None)
            context_ok = current is not None and current.get('context_length') == self.context_length
            exclusive = len(models) == 1 and current is not None
            ready = context_ok and exclusive
            return {'ok': ready, 'model': self.model, 'loaded': current is not None,
                    'exclusive_model': exclusive, 'configured_context_length': self.context_length,
                    'error': None if ready else 'FORGE must have only the configured model loaded with the configured context length.',
                    'details': current.get('details', {}) if current else {}, 'context_length': current.get('context_length') if current else None}
        except (OSError, ValueError, http.client.HTTPException):
            return {'ok': False, 'model': self.model, 'loaded': False, 'error': 'FORGE connection unavailable. Start the workspace launcher to restore the private tunnel.'}

    def generate(self, messages, on_token=None, max_tokens=2048, tools=None, cancel_event=None):
        _qwen_check(cancel_event)
        if not self.lock.acquire(blocking=False):
            _model_log.info(json.dumps({'schemaVersion': 1, 'event': 'workspace_model', 'provider': 'qwen', 'outcome': 'busy'}))
            raise ProviderUnavailableError('qwen', 'FORGE is answering another workspace request; wait for it to finish')
        started, outcome = time.monotonic(), 'unavailable'
        try:
            self.last_identity, self.last_usage = None, {}
            state = self.status(cancel_event=cancel_event) if cancel_event is not None else self.status()
            if not state.get('ok'):
                raise ProviderUnavailableError('qwen', state.get('error') or 'the configured FORGE model and context are not ready')
            _qwen_check(cancel_event)
            payload = {'model': self.model, 'messages': messages, 'stream': False, 'think': False,
                       'truncate': False, 'shift': False,
                       'options': {'num_ctx': self.context_length, 'num_predict': 1, 'temperature': 0}, 'keep_alive': -1}
            if tools:
                payload['tools'] = tools
            preflight = urllib.request.Request(self.base + '/api/chat', data=json.dumps(payload).encode(),
                                               headers={'Content-Type': 'application/json'}, method='POST')
            with _qwen_open(preflight, 600, cancel_event) as response:
                measured = json.load(response)
            if not isinstance(measured, dict) or measured.get('error'):
                raise ProviderUnavailableError('qwen', 'FORGE returned an invalid context measurement')
            prompt_tokens = measured.get('prompt_eval_count')
            if type(prompt_tokens) is not int or prompt_tokens < 1:
                raise ProviderUnavailableError('qwen', 'FORGE did not return a measured token count; generation was not started')
            if prompt_tokens + max_tokens + 1024 > self.context_length:
                raise ProviderUnavailableError('qwen', 'Compact this chat or remove attachments: the measured prompt exceeds the available context; originals remain saved')
            _qwen_check(cancel_event)
            self.last_usage = {'provider': 'qwen', 'context_measurement': 'ollama_measured', 'prompt_tokens': prompt_tokens,
                               'context_length': self.context_length, 'output_reserve': max_tokens}
            payload['stream'] = not bool(tools)
            payload['options'].update({'num_predict': max_tokens, 'temperature': .5})
            request = urllib.request.Request(self.base + '/api/chat', data=json.dumps(payload).encode(),
                                             headers={'Content-Type': 'application/json'}, method='POST')
            if tools:
                with _qwen_open(request, 600, cancel_event) as response:
                    result = json.load(response)
                if not isinstance(result, dict):
                    raise ProviderUnavailableError('qwen', 'FORGE returned an invalid response')
                message = result.get('message', {})
                if not isinstance(message, dict) or result.get('error') or not result.get('done') or not (message.get('content') or message.get('tool_calls')):
                    raise ProviderUnavailableError('qwen', 'FORGE did not return a complete answer or tool call')
                message = canonical_tool_message(message, tools, 'qwen')
                self.last_usage.update(completion_tokens=result.get('eval_count', 0),
                    prompt_tokens=result.get('prompt_eval_count', prompt_tokens), measured_at=now())
                actual = result.get('model')
                if actual is not None and actual != self.model:
                    raise ProviderUnavailableError('qwen', 'FORGE returned a different model than requested')
                _qwen_check(cancel_event)
                self.last_identity = {'provider': 'qwen', 'requested': self.model,
                    'model': actual if isinstance(actual, str) and actual else None,
                    'reported': isinstance(actual, str) and bool(actual)}
                outcome = 'returned'
                return message
            pieces, completed = [], False
            with _qwen_open(request, 600, cancel_event) as response:
                for line in response:
                    _qwen_check(cancel_event)
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    if not isinstance(chunk, dict) or not isinstance(chunk.get('message', {}), dict):
                        raise ProviderUnavailableError('qwen', 'FORGE returned an invalid stream event')
                    if chunk.get('error'):
                        raise ProviderUnavailableError('qwen', 'FORGE reported an inference error')
                    content = chunk.get('message', {}).get('content', '')
                    if content:
                        pieces.append(content)
                        if on_token:
                            on_token(content)
                    if chunk.get('done'):
                        self.last_usage.update(completion_tokens=chunk.get('eval_count', 0),
                            prompt_tokens=chunk.get('prompt_eval_count', prompt_tokens), measured_at=now())
                        completed = True
                        actual = chunk.get('model')
                        if actual is not None and actual != self.model:
                            raise ProviderUnavailableError('qwen', 'FORGE returned a different model than requested')
                        self.last_identity = {'provider': 'qwen', 'requested': self.model,
                            'model': actual if isinstance(actual, str) and actual else None,
                            'reported': isinstance(actual, str) and bool(actual)}
                        break
            if not completed or not ''.join(pieces).strip():
                raise ProviderUnavailableError('qwen', 'the model response was incomplete; your message remains saved')
            _qwen_check(cancel_event)
            outcome = 'returned'
            return ''.join(pieces)
        except ProviderCancelledError:
            outcome = 'cancelled'
            raise
        except (OSError, ValueError, http.client.HTTPException):
            _qwen_check(cancel_event)
            raise ProviderUnavailableError('qwen', 'FORGE timed out, disconnected or returned an invalid response; your message remains saved') from None
        finally:
            _model_log.info(json.dumps({'schemaVersion': 1, 'event': 'workspace_model', 'provider': 'qwen',
                                       'outcome': outcome, 'duration_ms': round((time.monotonic() - started) * 1000)}))
            self.lock.release()


class SyncWorker:
    def __init__(self, store, bridges):
        self.store, self.bridges = store, bridges
        self.lock, self.stop = threading.Lock(), threading.Event()

    def once(self):
        if not self.lock.acquire(blocking=False):
            return self.store.sync_status()
        try:
            eligible = [j for j in self.store.pending(1000) if not j.get('next_attempt') or j['next_attempt'] <= now()]
            for job in eligible[:12]:
                if self.stop.is_set():
                    break
                try:
                    if job['state'] != 'written':
                        # Read before a retry: a timed-out capture may already exist.
                        if job['attempts']:
                            read = self.bridges.call('ecf', 'continuity_recall', {'query': job['id'], 'limit': 5})
                            if verify_capture(job, read):
                                self.store.delivery(job['id'], 'verified', capture_event(job, read)['id'])
                                continue
                        self.bridges.call('ecf', 'continuity_capture', {'kind': 'note', 'title': job['title'][:200],
                            'detail': job['detail'], 'requestId': job['id']})
                        self.store.delivery(job['id'], 'written', 'Write returned; awaiting exact readback')
                        job['state'] = 'written'
                    read = self.bridges.call('ecf', 'continuity_recall', {'query': job['id'], 'limit': 5})
                    if verify_capture(job, read):
                        self.store.delivery(job['id'], 'verified', capture_event(job, read)['id'])
                    else:
                        self.store.delivery(job['id'], 'written', 'Waiting for exact ECF hash readback; not confirmed', delay=30)
                except Exception as exc:
                    reason = redact(str(exc))[:600]
                    state = 'written' if job['state'] == 'written' else ('blocked' if 'scope' in reason.lower() or 'permission' in reason.lower() else 'retry')
                    self.store.delivery(job['id'], state, reason, delay=min(300, 15 * 2 ** min(job['attempts'], 4)))
                    if state == 'blocked':
                        break
            return self.store.sync_status()
        finally:
            self.lock.release()

    def start(self):
        def loop():
            while not self.stop.is_set():
                self.once()
                self.stop.wait(5)
        threading.Thread(target=loop, daemon=True).start()
