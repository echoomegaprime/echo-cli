import json
import unittest
from unittest.mock import patch
from adapters import Stdio, unpack
from workspace import WorkspaceError

class EshReceiptTests(unittest.TestCase):
    def test_esh_failed_command_preserves_exit_and_output(self):
        client = Stdio({})
        receipt = {'envelope_version':1, 'ok':False, 'exit':7, 'stdout':'partial output', 'stderr':'failure detail', 'verdict':'allowed', 'audit_id':'receipt'}
        with patch.object(client, '_start'), patch.object(client, '_rpc', return_value={'content':[{'type':'text','text':json.dumps(receipt)}]}):
            self.assertEqual(client.call('esh_run', {'cmd':'fixture'}), receipt)

    def test_esh_denial_keeps_audit_receipt_for_display(self):
        client = Stdio({})
        receipt = {'envelope_version':1, 'ok':False, 'verdict':'gated', 'reason':'grant needed', 'audit_id':'denial-receipt'}
        with patch.object(client, '_start'), patch.object(client, '_rpc', return_value={'structuredContent':receipt}):
            self.assertEqual(client.call('esh_run', {'cmd':'fixture'}), receipt)

    def test_other_connector_denial_still_fails(self):
        with self.assertRaises(WorkspaceError):
            unpack({'ok':False,'error':'scope_forbidden'})

if __name__ == '__main__': unittest.main()
