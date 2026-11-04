import base64
import json
import socket
import tempfile
import unittest
from unittest.mock import Mock, patch
from app import Application
from internet import Internet
from knowledge import Knowledge
from voice import Voice
from workspace import Store, WorkspaceError
from providers import ProviderUnavailableError
from test_voice import wav_bytes


class AgentIntegrationTests(unittest.TestCase):
    def test_native_tool_loop_reads_previous_chat_and_persists_tool_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            app = Application(root, {})
            old = app.store.new_chat('Delivery')
            app.store.message(old['id'], 'user', 'Delivery code is PEAR-THURSDAY.', 'm1')
            new = app.store.new_chat()
            model = Mock(); model.generate.side_effect = [
                {'content': '', 'tool_calls': [{'function': {'name': 'workspace', 'arguments': {'action': 'read_chat', 'id': old['id']}}}]},
                {'content': 'Delivery code is PEAR-THURSDAY.'}]
            app.model = model; events = []; context = [{'role': 'user', 'content': 'Read the previous chat.'}]
            answer = app.answer_with_tools(context, new['id'], 'tool-loop-fixture', events.append)
            self.assertIn('PEAR-THURSDAY', answer)
            self.assertIn('PEAR-THURSDAY', context[-1]['content'])
            self.assertEqual(context[-1]['role'], 'tool')
            self.assertTrue(any(e['type'] == 'tool_result' for e in events))
            self.assertTrue(any(e['kind'] == 'tool_result' for e in app.store.chat(new['id'])['events']))

    def test_file_write_tool_is_idempotent_after_restart(self):
        with tempfile.TemporaryDirectory() as root:
            app = Application(root, {}); chat = app.store.new_chat()
            args = {'action': 'save_file', 'name': 'fixture.txt', 'content': 'Exact saved data.'}
            first = app.tools.execute('workspace', args, chat['id'], 'same-request')
            restored = Application(root, {})
            self.assertEqual(first, restored.tools.execute('workspace', args, chat['id'], 'same-request'))
            self.assertEqual(len(restored.store.library()), 1)
            self.assertEqual(restored.store.library_get(first['id'])['content'], 'Exact saved data.')

    def test_unknown_tool_attempt_is_not_repeated(self):
        with tempfile.TemporaryDirectory() as root:
            app = Application(root, {}); chat = app.store.new_chat()
            import hashlib
            args = {'action': 'list_chats'}
            digest = hashlib.sha256(('workspace\n' + json.dumps(args, sort_keys=True)).encode()).hexdigest()
            app.store.event(chat['id'], 'tool_started', json.dumps({'request_id': 'lost-reply', 'sha256': digest}))
            self.assertEqual(app.tools.execute('workspace', args, chat['id'], 'lost-reply')['state'], 'unknown')

    def test_knowledge_requires_exact_readback_and_never_rewrites_accepted_document(self):
        with tempfile.TemporaryDirectory() as root:
            store = Store(root); bridge = Mock(); k = Knowledge(store, bridge)
            k.enqueue('Fixture', 'Text with trailing whitespace.\n', 'fixture.txt')
            bridge.sdk.return_value = {'ok': True}
            self.assertEqual(k.once()['written'], 1)
            with k.db() as db:
                row = dict(db.execute('SELECT * FROM documents').fetchone())
                db.execute('UPDATE documents SET next_attempt=0')
            bridge.reset_mock()
            bridge.sdk.return_value = {'data': {'doc_id': row['id'], 'body_sha256': row['sha256'], 'body_md': row['body']}}
            self.assertEqual(k.once()['verified'], 1)
            self.assertTrue(all(c.args[0] == 'echo.knowledge.get' for c in bridge.sdk.call_args_list))

    def test_public_web_reader_rejects_internal_targets_before_connecting(self):
        with patch('socket.getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 80))]), patch('socket.create_connection') as connect:
            with self.assertRaises(WorkspaceError): Internet(None).read('http://example.test/private')
            connect.assert_not_called()

    def test_v4_chunk_contains_no_chat_identifier_and_replay_does_not_resynthesize(self):
        with tempfile.TemporaryDirectory() as root:
            store = Store(root); chat = store.new_chat()
            m = store.message(chat['id'], 'assistant', 'Chat `cd2fb20657c44f5d8f6c7cfdd20c0b28`: your meeting is at 4 PM.', 'reply')
            v = Voice({'voice': {'persona': 'freeman', 'label': 'M Freeman', 'model': 'eleven_v4'}}, None, store)
            sent = []
            def helper(operation, **args):
                if operation == 'prepare':
                    self.assertNotIn('cd2fb206', args['text']); return {'chunks': [args['text']]}
                if operation == 'speak':
                    sent.append(args); return {'provider': 'elevenlabs', 'format': 'wav', 'url': 'http://fixture/audio', 'requested_model': args['model']}
                return {'audio_b64': base64.b64encode(wav_bytes()).decode(), 'duration_s': .1}
            body = {'chat_id': chat['id'], 'message_id': m['id'], 'request_id': 'v4-fixture-request'}
            with patch.object(v, 'helper', side_effect=helper):
                self.assertEqual(v.start(body), v.start(body))
            self.assertEqual(len(sent), 1)
            self.assertEqual(sent[0]['model'], 'eleven_v4')
            self.assertIn('4 PM', sent[0]['text'])



    def test_capability_guide_covers_every_native_tool_and_full_sdk_namespaces(self):
        with tempfile.TemporaryDirectory() as root:
            app = Application(root, {})
            app.catalog = [{'id': 'echo.node.exec', 'namespace': 'node'},
                           {'id': 'echo.knowledge.search', 'namespace': 'knowledge'},
                           {'id': 'echo.vault.health', 'namespace': 'vault'}]
            guide = app.tools.guide()
            names = {t['function']['name'] for t in app.tools.definitions()}
            self.assertEqual(names, {t['name'] for t in guide['tools']})
            self.assertEqual(guide['sdk']['families'], {'knowledge': 1, 'node': 1, 'vault': 1})
            self.assertIn('sdk_search', guide['instructions'])
            self.assertIn('node_execute', guide['instructions'])
            self.assertIn('ShadowGlass', guide['instructions'])
            self.assertEqual(guide['features']['shadowglass_control'], 'not integrated')
            self.assertEqual(guide['features']['media_creation'], 'not installed')

    def test_capability_context_is_loaded_without_requiring_a_memory_match_or_disclosing_config(self):
        with tempfile.TemporaryDirectory() as root:
            app = Application(root, {'private_config': 'DO_NOT_INCLUDE_FIXTURE', 'voice': {'label': 'Test voice'}})
            guide = app.agent_instructions()
            self.assertIn('ECHO CAPABILITY GUIDE', guide)
            self.assertIn('read_chat', guide)
            self.assertIn('remember', guide)
            self.assertNotIn('DO_NOT_INCLUDE_FIXTURE', guide)
            from workspace import build_context
            context = build_context({'messages': [], 'summary': 'Checkpoint'}, directive=guide)
            self.assertIn('ECHO CAPABILITY GUIDE', context[0]['content'])

    def test_capability_tool_returns_audited_current_guide(self):
        with tempfile.TemporaryDirectory() as root:
            app = Application(root, {}); chat = app.store.new_chat()
            guide = app.tools.execute('capabilities', {}, chat['id'], 'guide-fixture')
            self.assertTrue(guide['ok'])
            self.assertEqual(len(guide['guide_sha256']), 64)
            self.assertTrue(any(e['kind'] == 'tool_result' and 'guide_sha256' in e['content']
                                for e in app.store.chat(chat['id'])['events']))


    def test_repeated_tool_call_is_not_executed_twice_and_finishes_with_text(self):
        with tempfile.TemporaryDirectory() as root:
            app = Application(root, {}); chat = app.store.new_chat()
            call = {'function': {'name': 'workspace', 'arguments': {'action': 'list_library'}}}
            app.model = Mock(); app.model.generate.side_effect = [
                {'content': '', 'tool_calls': [call]}, {'content': '', 'tool_calls': [call]}, 'The library is empty.']
            events = []
            answer = app.answer_with_tools([{'role':'user','content':'Check my library.'}], chat['id'], 'repeat', events.append)
            self.assertEqual(answer, 'The library is empty.')
            self.assertEqual(len([e for e in events if e['type']=='tool_started']), 1)
            self.assertNotIn('tools', app.model.generate.call_args.kwargs)
            self.assertTrue(any(e['kind']=='tool_loop_summary' for e in app.store.chat(chat['id'])['events']))

    def test_tool_budget_forces_a_plain_answer_after_bounded_work(self):
        with tempfile.TemporaryDirectory() as root:
            app = Application(root, {'max_tool_rounds': 2}); chat = app.store.new_chat()
            app.model = Mock(); app.model.generate.side_effect = [
                {'tool_calls':[{'function':{'name':'workspace','arguments':{'action':'list_chats'}}}]},
                {'tool_calls':[{'function':{'name':'workspace','arguments':{'action':'list_projects'}}}]},
                'I checked your chats and projects.']
            events=[]; answer=app.answer_with_tools([{'role':'user','content':'List my work.'}],chat['id'],'budget',events.append)
            self.assertEqual(answer,'I checked your chats and projects.')
            self.assertEqual(len([e for e in events if e['type']=='tool_started']),2)
            self.assertNotIn('tools', app.model.generate.call_args.kwargs)

    def test_empty_or_failed_final_generation_fails_and_preserves_completed_receipts(self):
        for final in ['', WorkspaceError('fixture inference failure')]:
            with tempfile.TemporaryDirectory() as root:
                app=Application(root,{'max_tool_rounds':1});chat=app.store.new_chat()
                app.model=Mock();app.model.generate.side_effect=[
                    {'tool_calls':[{'function':{'name':'workspace','arguments':{'action':'list_library'}}}]},final]
                with self.assertRaises(ProviderUnavailableError) as failure:
                    app.answer_with_tools([{'role':'user','content':'List files.'}],chat['id'],'fallback',lambda e:None)
                self.assertNotIn('fixture', str(failure.exception))
                self.assertEqual(app.model.generate.call_count, 2)
                self.assertNotIn('tools', app.model.generate.call_args.kwargs)
                saved = app.store.chat(chat['id'])
                receipts = [json.loads(event['content']) for event in saved['events'] if event['kind'] == 'tool_result']
                self.assertEqual(len(receipts), 1)
                self.assertEqual(receipts[0]['request_id'], 'fallback:tool:0:0')
                self.assertEqual(receipts[0]['result'], {'files': []})
                self.assertFalse(any(message['role'] == 'assistant' for message in saved['messages']))

    def test_request_to_respond_verbally_does_not_launch_more_tools(self):
        with tempfile.TemporaryDirectory() as root:
            app=Application(root,{});chat=app.store.new_chat();app.model=Mock()
            app.model.generate.return_value='I am here. I will answer you directly.'
            events=[];answer=app.answer_with_tools([{'role':'user','content':'why are you not responding vernally'}],chat['id'],'verbal',events.append)
            self.assertIn('answer you directly',answer)
            self.assertNotIn('tools',app.model.generate.call_args.kwargs)
            self.assertFalse(any(e['type']=='tool_started' for e in events))

if __name__ == '__main__': unittest.main()
