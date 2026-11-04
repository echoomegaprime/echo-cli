"""Personality Forge speech integration; provider secrets never enter this client."""
import base64
import hashlib
import io
import json
import re
import subprocess
import threading
import uuid
import wave
from pathlib import Path
from workspace import WorkspaceError, redact


def spoken_text(text, read_identifiers=False):
    """Keep useful quantities; omit screen-only identifiers and paths from speech."""
    text = redact(text)
    if not read_identifiers:
        text = re.sub(r'\b(?:[A-Za-z]+[-_])?[a-fA-F0-9]{20,}\b|\b[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\b', '', text)
        text = re.sub(r'(?:[A-Za-z]:\\|/(?:home|mnt|etc|var|tmp|Users)/)[^\s`<>]+', '', text)
        text = re.sub(r'\b\d{10,}\b', '', text)
        text = re.sub(r'(?i)\b(?:chat|receipt|sha-?256|hash|file)\s*[`*]*\s*(?=[:.,]|$)', 'that conversation' if 'chat' in text.lower() else '', text)
    return re.sub(r'[ \t]{2,}', ' ', text).strip()


class Voice:
    def __init__(self, config, bridges, store):
        self.config, self.bridges, self.store = config.get('voice', {}), bridges, store
        self.sessions, self.starts, self.transcripts = {}, {}, {}
        self.lock = threading.Lock()
        self.root = store.root / 'voice'

    def status(self):
        return {'configured': bool(self.config), 'persona': self.config.get('persona'),
                'label': self.config.get('label'), 'provider': 'elevenlabs',
                'model': self.config.get('model', 'gateway default'), 'emotion': 'expressive' if self.config.get('model') else 'gateway default',
                'internal_identifiers_spoken': False,
                'stt_provider': 'elevenlabs-scribe', 'end_of_turn_ms': 2000,
                'microphone': 'off_until_user_starts', 'provider_usage': 'Cloud speech uses your ElevenLabs account.'}

    def helper(self, operation, **payload):
        if not self.config:
            raise WorkspaceError('Personality Forge voice is not configured.')
        request = {**payload, 'operation': operation, 'plugin_root': self.config['plugin_root'],
                   'gateway_base': self.config['gateway_base']}
        result = subprocess.run([self.config.get('node', 'node'), str(Path(__file__).with_name('voice_transport.mjs'))],
            input=json.dumps(request), capture_output=True, text=True, encoding='utf-8', timeout=150,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode:
            try: reason = json.loads(result.stderr)['error']
            except (ValueError, KeyError): reason = 'Voice transport failed.'
            raise WorkspaceError(redact(reason)[:200])
        return json.loads(result.stdout)

    def _publish(self, result, chat_id):
        audio = result.get('audio')
        if not isinstance(audio, dict) or audio.get('provider') != 'elevenlabs' or audio.get('format') != 'wav':
            raise WorkspaceError('Personality Forge did not confirm the requested voice provider and format.')
        received = self.helper('audio', url=audio['url'])
        data = base64.b64decode(received.pop('audio_b64'), validate=True)
        file_id = uuid.uuid4().hex
        self.root.mkdir(parents=True, exist_ok=True)
        path = self.root / (file_id + '.wav')
        path.write_bytes(data)
        receipt = {'provider': 'elevenlabs', 'persona': self.config['persona'], 'label': self.config['label'],
                   'requested_model': audio.get('requested_model', 'gateway default'),
                   'path': str(path), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), **received}
        self.store.event(chat_id, 'speech_artifact', json.dumps(receipt))
        return {'audio_url': '/api/voice/audio/' + file_id, 'has_more': bool(result.get('has_more')),
                'session_id': result['session_id'], 'chunk_index': result.get('chunk_index', 0),
                'provider': 'elevenlabs', 'voice': self.config['label'], **received}

    def start(self, body):
        if not self.config:
            raise WorkspaceError('Personality Forge voice is not configured.')
        chat_id, message_id, request_id = body.get('chat_id'), body.get('message_id'), body.get('request_id')
        if not isinstance(request_id, str) or not re.fullmatch(r'[\w-]{8,100}', request_id):
            raise WorkspaceError('A speech request ID is required.')
        chat = self.store.chat(chat_id)
        message = next((m for m in chat['messages'] if m['id'] == message_id and m['role'] == 'assistant'), None)
        if not message:
            raise WorkspaceError('Select a saved assistant reply to hear.')
        mode = body.get('mode', 'full')
        if mode not in ('full', 'summary'):
            raise WorkspaceError('Choose full or brief speech.')
        if len(message['content']) > 30000:
            raise WorkspaceError('This reply is too long for speech. Ask for a shorter spoken version.')
        key = (chat_id, request_id)
        with self.lock:
            if key in self.starts:
                prior = self.starts[key]
                if prior['message_id'] != message_id or prior['mode'] != mode:
                    raise WorkspaceError('Speech request ID was reused for a different reply.')
                if prior.get('result'):
                    return prior['result']
                raise WorkspaceError('Speech was already attempted. Check the journal before choosing Listen again.')
            self.starts[key] = {'message_id': message_id, 'mode': mode}
            self.store.event(chat_id, 'speech_requested', json.dumps({'message_id': message_id, 'request_id': request_id,
                'provider': 'elevenlabs', 'persona': self.config['persona'], 'mode': mode}))
            if self.config.get('model'):
                prepared = self.helper('prepare', text=spoken_text(message['content'], bool(body.get('read_identifiers'))), mode=mode)
                chunks = prepared.get('chunks') or []
                if not chunks: raise WorkspaceError('This reply has no spoken text after screen-only details are removed.')
                sid = uuid.uuid4().hex
                session = {'chat_id': chat_id, 'cancelled': False, 'chunks': {}, 'text_chunks': chunks, 'next_index': 1}
                self.sessions[sid] = session
                audio = self.helper('speak', text=chunks[0], persona=self.config['persona'], model=self.config['model'])
                result = {'audio': audio, 'session_id': sid, 'chunk_index': 0, 'has_more': len(chunks) > 1}
                published = self._publish(result, chat_id)
                session['chunks'][0] = published
                self.starts[key]['result'] = published
                return published
            result = self.bridges.call('personality', 'echo_personality_start_progressive_synthesis',
                {'text': spoken_text(message['content'], bool(body.get('read_identifiers'))), 'persona_id': self.config['persona'], 'provider': 'elevenlabs',
                 'format': 'wav', 'mode': mode, 'confirm': 'EXECUTE'})
            session = {'chat_id': chat_id, 'cancelled': False, 'chunks': {}, 'next_index': 1}
            self.sessions[result['session_id']] = session
            published = self._publish(result, chat_id)
            session['chunks'][0] = published
            self.starts[key]['result'] = published
            return published

    def next(self, body):
        with self.lock:
            session = self.sessions.get(body.get('session_id'))
            if not session or session['cancelled'] or session['chat_id'] != body.get('chat_id'):
                raise WorkspaceError('The speech session ended or belongs to a different chat.')
            index = body.get('chunk_index')
            if type(index) is not int or index < 1:
                raise WorkspaceError('A speech chunk index is required.')
            if index in session['chunks']:
                return session['chunks'][index]
            if index != session['next_index']:
                raise WorkspaceError('Speech chunks must be requested in order.')
            # Reserve before a provider call. An ambiguous timeout is not automatically replayed.
            session['next_index'] += 1
            if 'text_chunks' in session:
                if index >= len(session['text_chunks']): raise WorkspaceError('Speech session has no more chunks.')
                audio = self.helper('speak', text=session['text_chunks'][index], persona=self.config['persona'], model=self.config['model'])
                result = {'audio': audio, 'session_id': body['session_id'], 'chunk_index': index, 'has_more': index + 1 < len(session['text_chunks'])}
                published = self._publish(result, session['chat_id'])
                session['chunks'][index] = published
                return published
            result = self.bridges.call('personality', 'echo_personality_next_progressive_chunk',
                {'session_id': body['session_id'], 'confirm': 'EXECUTE'})
            published = self._publish(result, session['chat_id'])
            session['chunks'][index] = published
            return published

    def cancel(self, body):
        session = self.sessions.get(body.get('session_id'))
        if session and session['chat_id'] == body.get('chat_id'):
            session['cancelled'] = True
        return {'stopped': True, 'in_flight_provider_work_may_finish': True}

    def transcribe(self, body):
        chat_id = body.get('chat_id')
        self.store.chat(chat_id)
        encoded, request_id = body.get('audio_b64'), body.get('request_id')
        if not isinstance(encoded, str) or len(encoded) > 350000 or not isinstance(request_id, str) or not re.fullmatch(r'[\w-]{8,100}', request_id):
            raise WorkspaceError('Send a bounded microphone clip with a request ID.')
        try:
            audio = base64.b64decode(encoded, validate=True)
            with wave.open(io.BytesIO(audio), 'rb') as wav:
                if wav.getnchannels() != 1 or wav.getframerate() != 16000 or wav.getsampwidth() != 2 or not 0 < wav.getnframes() <= 128000:
                    raise ValueError()
            if len(audio) > 262144: raise ValueError()
        except (ValueError, wave.Error, EOFError):
            raise WorkspaceError('Expected up to eight seconds of mono 16 kHz PCM WAV audio.') from None
        key, digest = (chat_id, request_id), hashlib.sha256(audio).hexdigest()
        with self.lock:
            if key in self.transcripts:
                prior = self.transcripts[key]
                if prior['sha256'] != digest: raise WorkspaceError('Transcription request ID was reused.')
                if prior.get('result'): return prior['result']
                raise WorkspaceError('Transcription was already attempted; no automatic provider retry was sent.')
            self.transcripts[key] = {'sha256': digest}
            result = self.helper('transcribe', audio_b64=encoded)
            if result.get('provider') != 'elevenlabs-scribe' or not isinstance(result.get('text'), str):
                raise WorkspaceError('The transcription provider was not verified.')
            result = {'provider': 'elevenlabs-scribe', 'text': redact(result['text'])}
            self.store.event(chat_id, 'speech_transcription', json.dumps({**result, 'audio_sha256': digest,
                'audio_bytes': len(audio), 'raw_microphone_audio_retained': False}))
            self.transcripts[key]['result'] = result
            return result

    def audio(self, file_id):
        if not re.fullmatch(r'[a-f0-9]{32}', file_id):
            raise WorkspaceError('Unknown speech artifact.')
        return (self.root / (file_id + '.wav')).read_bytes()
