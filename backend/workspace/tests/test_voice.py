import base64
import io
import json
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import Mock, patch
from voice import Voice
from workspace import Store, WorkspaceError


def wav_bytes(rate=16000, frames=1600):
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(rate); wav.writeframes(b'\0\0' * frames)
    return output.getvalue()


class VoiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name))
        self.chat = self.store.new_chat()
        self.store.message(self.chat['id'], 'assistant', 'A short speech fixture.', 'reply')
        self.message = self.store.chat(self.chat['id'])['messages'][0]
        self.bridge = Mock()
        self.voice = Voice({'voice': {'persona': 'freeman', 'label': 'M Freeman'}}, self.bridge, self.store)

    def tearDown(self):
        self.temp.cleanup()

    def test_malformed_audio_and_wrong_rate_never_reach_provider(self):
        with patch.object(self.voice, 'helper') as helper:
            for audio in (b'not-a-wav', wav_bytes(24000), wav_bytes(frames=129000)):
                with self.assertRaises(WorkspaceError):
                    self.voice.transcribe({'chat_id': self.chat['id'], 'request_id': 'fixture-request',
                                           'audio_b64': base64.b64encode(audio).decode()})
            helper.assert_not_called()

    def test_transcription_replay_is_exact_and_raw_audio_is_not_journaled(self):
        body = {'chat_id': self.chat['id'], 'request_id': 'fixture-request', 'audio_b64': base64.b64encode(wav_bytes()).decode()}
        with patch.object(self.voice, 'helper', return_value={'provider': 'elevenlabs-scribe', 'text': 'Hello Echo.'}) as helper:
            first = self.voice.transcribe(body)
            self.assertEqual(first, self.voice.transcribe(body))
            self.assertEqual(helper.call_count, 1)
        journal = self.store.journal(self.chat['id']).read_text()
        self.assertIn('Hello Echo.', journal)
        self.assertNotIn(body['audio_b64'], journal)

    def test_speech_provider_mismatch_is_rejected(self):
        with self.assertRaises(WorkspaceError):
            self.voice._publish({'audio': {'provider': 'chatterbox', 'format': 'wav'}}, self.chat['id'])

    def test_start_replay_saves_one_artifact_and_next_obeys_chat_and_cancel(self):
        self.bridge.call.return_value = {'audio': {'provider': 'elevenlabs', 'format': 'wav', 'url': 'http://fixture/audio'},
            'session_id': 'fixture-session', 'chunk_index': 0, 'has_more': True}
        body = {'chat_id': self.chat['id'], 'message_id': self.message['id'], 'request_id': 'fixture-request'}
        with patch.object(self.voice, 'helper', return_value={'audio_b64': base64.b64encode(wav_bytes()).decode(), 'duration_s': .1}):
            first = self.voice.start(body)
            self.assertEqual(first, self.voice.start(body))
            self.assertEqual(self.bridge.call.call_count, 1)
        self.assertEqual(len(list(self.voice.root.glob('*.wav'))), 1)
        self.assertEqual(self.voice.audio(first['audio_url'].split('/')[-1]), wav_bytes())
        for chat in ('different-chat', self.chat['id']):
            if chat == self.chat['id']:
                self.voice.cancel({'session_id': 'fixture-session', 'chat_id': chat})
            with self.assertRaises(WorkspaceError):
                self.voice.next({'session_id': 'fixture-session', 'chat_id': chat, 'chunk_index': 1})

    def test_timeout_does_not_retry_a_possibly_billed_request(self):
        self.bridge.call.side_effect = TimeoutError('fixture timeout')
        body = {'chat_id': self.chat['id'], 'message_id': self.message['id'], 'request_id': 'fixture-request'}
        with self.assertRaises(TimeoutError): self.voice.start(body)
        with self.assertRaisesRegex(WorkspaceError, 'already attempted'): self.voice.start(body)
        self.assertEqual(self.bridge.call.call_count, 1)

    def test_audio_path_cannot_escape_generated_directory(self):
        with self.assertRaises(WorkspaceError): self.voice.audio('../../workspace.sqlite3')

    def test_microphone_defaults_off(self):
        self.assertEqual(self.voice.status()['microphone'], 'off_until_user_starts')
        self.assertEqual(self.voice.status()['end_of_turn_ms'], 2000)


if __name__ == '__main__': unittest.main()
