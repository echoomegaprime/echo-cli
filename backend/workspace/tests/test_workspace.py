import json
import tempfile
import unittest
from pathlib import Path

from workspace import Store, redact, build_context, WorkspaceError, verify_capture


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = Store(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_new_chat_has_journal_and_survives_restart(self):
        chat = self.store.new_chat('First project chat')
        self.assertTrue(Path(chat['journal_path']).is_file())
        self.store.message(chat['id'], 'user', 'Remember the blue door', 'send-1')
        resumed = Store(self.root).chat(chat['id'])
        self.assertEqual(resumed['messages'][0]['content'], 'Remember the blue door')
        self.assertIn('blue door', Path(resumed['journal_path']).read_text(encoding='utf-8'))

    def test_duplicate_send_is_idempotent(self):
        c = self.store.new_chat()
        a = self.store.message(c['id'], 'user', 'Only once', 'one')
        b = self.store.message(c['id'], 'user', 'Only once', 'one')
        self.assertEqual(a, b)
        self.assertEqual(len(self.store.chat(c['id'])['messages']), 1)
        with self.assertRaises(WorkspaceError):
            self.store.message(c['id'], 'user', 'Different', 'one')

    def test_compaction_preserves_history_and_continuation(self):
        c = self.store.new_chat()
        for n in range(8):
            self.store.message(c['id'], 'user' if n % 2 == 0 else 'assistant', f'message {n}', str(n))
        before = self.store.chat(c['id'])
        cutoff = before['messages'][3]['seq']
        self.store.compact(c['id'], 'The first four messages discussed a door.', cutoff)
        after = self.store.chat(c['id'])
        self.assertEqual(len(after['messages']), 8)
        context = build_context(after, '')
        self.assertIn('first four', context[1]['content'])
        self.assertEqual(context[-1]['content'], 'message 7')
        self.assertFalse(any(x['content'] == 'message 0' for x in context))
        journal = Path(after['journal_path']).read_text(encoding='utf-8')
        self.assertIn('message 0', journal)
        self.assertIn('first four', journal)

    def test_project_and_library_survive_and_paths_are_safe(self):
        p = self.store.new_project('Launch', 'Use plain English')
        c = self.store.new_chat('Plan', p['id'])
        item = self.store.library_add('notes.md', 'Project notes', c['id'], p['id'])
        again = Store(self.root)
        self.assertEqual(again.project(p['id'])['instructions'], 'Use plain English')
        self.assertEqual(Path(item['path']).read_text(encoding='utf-8'), 'Project notes')
        self.assertIn(item['path'], Path(c['journal_path']).read_text(encoding='utf-8'))
        for bad in ['../../secret', 'C:\\Windows\\thing', 'x/y', 'CON', '..']:
            with self.assertRaises(WorkspaceError):
                self.store.library_add(bad, 'x')

    def test_secrets_redacted_before_storage_and_outbox(self):
        c = self.store.new_chat()
        secret = 'sk-' + 'a' * 40
        self.store.message(c['id'], 'user', 'api_key=' + secret, '1')
        self.assertNotIn(secret, json.dumps(self.store.chat(c['id'])))
        self.assertNotIn(secret, Path(c['journal_path']).read_text(encoding='utf-8'))
        self.assertNotIn(secret, json.dumps(self.store.pending()))
        self.assertIn('REDACTED', redact('Authorization: Bearer ' + 'b' * 48))

    def test_outbox_requires_exact_readback_not_just_success(self):
        c = self.store.new_chat()
        job = self.store.pending()[0]
        self.assertFalse(verify_capture(job, {'ok': True, 'events': []}))
        event = {'id': 'evt_example', 'content_text': job['title'] + '\n' + job['detail'], 'verification_state': 'UNVERIFIED'}
        self.assertTrue(verify_capture(job, {'ok': True, 'events': [event]}))
        self.store.delivery(job['id'], 'verified', 'evt_example')
        self.assertNotIn(job['id'], [j['id'] for j in self.store.pending()])
        self.assertEqual(Store(self.root).sync_status()['verified'], 1)

    def test_large_event_is_split_without_loss(self):
        c = self.store.new_chat()
        text = 'Long text ' * 4000
        self.store.message(c['id'], 'user', text, 'long')
        jobs = [j for j in self.store.pending() if 'user' in j['title']]
        self.assertGreater(len(jobs), 1)
        self.assertTrue(all(len(j['detail']) <= 20000 for j in jobs))
        self.assertEqual(self.store.chat(c['id'])['messages'][0]['content'], text)

    def test_context_budget_does_not_silently_drop_messages(self):
        c = self.store.new_chat()
        self.store.message(c['id'], 'user', 'x' * 50000, 'big')
        with self.assertRaisesRegex(WorkspaceError, 'Compact'):
            build_context(self.store.chat(c['id']), '', max_chars=24000)

    def test_invalid_chat_cannot_write_files_or_messages(self):
        with self.assertRaises(WorkspaceError):
            self.store.message('../escape', 'user', 'x', '1')
        with self.assertRaises(WorkspaceError):
            self.store.library_add('note.txt', 'hello', 'missing')
        self.assertEqual(list((self.root / 'library').glob('*')), [])

    def test_import_retains_source_and_message_order(self):
        data = {'source': 'claude', 'title': 'Imported', 'messages': [
            {'role': 'user', 'content': 'first', 'timestamp': '2026-10-01T01:00:00Z'},
            {'role': 'assistant', 'content': 'second'}]}
        chat = self.store.import_chat(data)
        self.assertEqual(chat['source'], 'claude')
        self.assertEqual([x['content'] for x in chat['messages']], ['first', 'second'])
        self.assertIn('2026-10-01', Path(chat['journal_path']).read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
