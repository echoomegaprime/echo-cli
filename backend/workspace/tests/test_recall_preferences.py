import tempfile
import unittest
from unittest.mock import Mock
from app import Application
from workspace import Store
from voice import spoken_text
from preferences import Preferences
from personalities import Personalities


class RecallPreferencesTests(unittest.TestCase):
    def test_last_conversation_retrieves_real_messages_without_topic_keywords(self):
        with tempfile.TemporaryDirectory() as root:
            app = Application(root, {})
            prior = app.store.new_chat('Orchard schedule')
            app.store.message(prior['id'], 'user', 'The pear delivery is due Thursday at 4 PM.', 'old-1')
            app.store.message(prior['id'], 'assistant', 'The pear delivery is Thursday at 4 PM.', 'old-2')
            current = app.store.new_chat()
            evidence = app.remember_context('Do you remember our last conversation?', current['id'], external=False)
            self.assertIn('pear delivery', evidence)
            self.assertIn(prior['id'], evidence)
            self.assertIn('Thursday', evidence)

    def test_explicit_memory_survives_restart_and_enters_ecf_outbox(self):
        with tempfile.TemporaryDirectory() as root:
            store = Store(root); chat = store.new_chat()
            preferences = Preferences(store)
            text = "Remember: don't say chat IDs and all those numbers out loud."
            saved = preferences.capture(text, chat['id'])
            self.assertTrue(saved['saved'])
            self.assertIn(text, Preferences(Store(root)).context())
            self.assertTrue(any('preference_saved' in r['title'] for r in store.pending()))
            self.assertEqual(saved['id'], preferences.capture(text, chat['id'])['id'])
            self.assertEqual(len(preferences.list()), 1)
            self.assertIsNone(preferences.capture('Do you remember what we said yesterday?', chat['id']))

    def test_speech_omits_internal_identifiers_but_keeps_meaningful_numbers(self):
        text = '**Chat `cd2fb20657c44f5d8f6c7cfdd20c0b28`**: meet at 4 PM. It costs $25. File C:\\work\\notes.md. Receipt evt_0123456789abcdef0123456789abcdef.'
        spoken = spoken_text(text)
        self.assertNotIn('cd2fb206', spoken)
        self.assertNotIn('evt_', spoken)
        self.assertNotIn('C:\\', spoken)
        self.assertIn('4 PM', spoken)
        self.assertIn('$25', spoken)

    def test_echo_prime_identity_remains_when_specialist_is_hot_loaded(self):
        with tempfile.TemporaryDirectory() as root:
            store = Store(root); chat = store.new_chat()
            bridge = Mock(); bridge.sdk.return_value = {'personalities': []}
            personalities = Personalities(store, bridge)
            receipt, prompt = personalities.context(chat['id'], 'hello')
            self.assertEqual(receipt['identity'], 'Echo Prime')
            self.assertIn('Echo Prime', prompt)
            personalities.select(chat['id'], 'gs343')
            receipt, prompt = personalities.context(chat['id'], 'research')
            self.assertEqual(receipt['profile'], 'gs343')
            self.assertEqual(receipt['identity'], 'Echo Prime')


if __name__ == '__main__':
    unittest.main()
