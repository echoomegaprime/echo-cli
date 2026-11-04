"""Real HTTP regressions for isolated extraction of the Workspace session cookie."""
import http.client
import json
import time
import unittest
from unittest.mock import patch

import test_auth_http as http_fixture


class CookieIsolationTests(unittest.TestCase):
    setUp = http_fixture.HttpIsolationTests.setUp
    tearDown = http_fixture.HttpIsolationTests.tearDown
    request = http_fixture.HttpIsolationTests.request
    login = http_fixture.HttpIsolationTests.login

    def read_with_headers(self, headers, path='/api/chats'):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=4)
        try:
            conn.putrequest('GET', path)
            for name, value in headers:
                conn.putheader(name, value)
            conn.endheaders()
            response = conn.getresponse()
            response.read()
            return response.status
        finally:
            conn.close()

    def test_unrelated_json_cookie_before_or_after_valid_session(self):
        cookie, _, _ = self.login('owner')
        for label, raw in [
            ('json_prefix', 'g_state={"i_l":0}; ' + cookie),
            ('json_suffix', cookie + '; g_state={"i_l":0}'),
            ('both', 'g_state={"i_l":0}; ' + cookie + '; theme=emerald'),
            ('quoted_unrelated', 'other="unclosed; ' + cookie),
        ]:
            with self.subTest(position=label):
                self.assertEqual(self.read_with_headers([('Cookie', raw)]), 200)

    def test_duplicate_own_cookie_is_never_accepted(self):
        cookie, _, _ = self.login('owner')
        for label, raw in [
            ('same', cookie + '; ' + cookie),
            ('empty_first', 'echo_workspace_session=; ' + cookie),
            ('empty_last', cookie + '; echo_workspace_session='),
            ('malformed_name_first', cookie.replace('=', ' =', 1) + '; ' + cookie),
        ]:
            with self.subTest(case=label):
                self.assertEqual(self.read_with_headers([('Cookie', raw)]), 401)

    def test_multiple_cookie_header_lines_are_refused(self):
        cookie, _, _ = self.login('owner')
        self.assertEqual(self.read_with_headers([('Cookie', cookie), ('Cookie', cookie)]), 401)

    def test_malformed_own_cookie_and_unknown_session_are_refused(self):
        cookie, _, _ = self.login('owner')
        value = cookie.split('=', 1)[1]
        for label, raw in [
            ('quoted', 'echo_workspace_session="' + value + '"'),
            ('trailing_space_in_name', 'echo_workspace_session =' + value),
            ('comma', cookie + ',other=value'),
            ('non_ascii', 'echo_workspace_session=' + '\u00e9' * 43),
            ('unknown_session', 'echo_workspace_session=' + 'x' * 43),
            ('unrelated_marker', 'g_state={"echo_workspace_session":"' + value + '"}'),
        ]:
            with self.subTest(case=label):
                self.assertEqual(self.read_with_headers([('Cookie', raw)]), 401)

    def test_oversized_header_is_refused_without_losing_real_session(self):
        cookie, _, _ = self.login('owner')
        self.assertEqual(self.read_with_headers([('Cookie', 'other=' + 'x' * 8200 + '; ' + cookie)]), 401)
        self.assertEqual(self.read_with_headers([('Cookie', cookie)]), 200)

    def test_contamination_does_not_weaken_csrf_or_origin(self):
        cookie, csrf, _ = self.login('owner')
        raw = 'g_state={"i_l":0}; ' + cookie
        self.assertEqual(self.request('POST', '/api/chats', {'title': 'allowed'}, raw, csrf)[0], 200)
        self.assertEqual(self.request('POST', '/api/chats', {'title': 'denied'}, raw, 'wrong')[0], 403)
        self.assertEqual(self.request('POST', '/api/chats', {'title': 'denied'}, raw, csrf, 'https://attacker.invalid')[0], 403)
        self.assertEqual(self.read_with_headers([('Cookie', raw), ('Origin', 'https://attacker.invalid')]), 403)

    def test_early_origin_rejection_consumes_sent_body_without_private_admission(self):
        handler = self.server.RequestHandlerClass
        original_setup, original_start = handler.setup, handler.start
        consumed = []
        class CountBodyReads:
            def __init__(self, reader, owner):
                self.reader, self.owner = reader, owner
            def __getattr__(self, name):
                return getattr(self.reader, name)
            def read(self, size=-1):
                value = self.reader.read(size)
                self.owner.body_bytes_read += len(value)
                return value
            def read1(self, size=-1):
                value = self.reader.read1(size)
                self.owner.body_bytes_read += len(value)
                return value
        def setup(h):
            original_setup(h)
            h.body_bytes_read = 0
            h.rfile = CountBodyReads(h.rfile, h)
        def start(h, status=200, *args, **kwargs):
            if status == 403:
                consumed.append(h.body_bytes_read)
            return original_start(h, status, *args, **kwargs)
        body = {'title': 'rejected', 'content': 'fixture ' * 1024}
        expected = len(json.dumps(body).encode())
        with patch.object(handler, 'setup', setup), patch.object(handler, 'start', start), \
                patch.object(self.server.accounts, 'authorize', wraps=self.server.accounts.authorize) as authorize:
            for _ in range(8):
                self.assertEqual(self.request('POST', '/api/chats', body, origin='https://attacker.invalid')[0], 403)
        self.assertEqual(consumed, [expected] * 8)
        authorize.assert_not_called()
        self.assertEqual(self.owner.store.chats(), [])

    def test_rejected_incomplete_body_has_a_short_drain_deadline(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=2)
        started = time.monotonic()
        try:
            connection.putrequest('POST', '/api/chats')
            for name, value in [('Content-Type', 'application/json'), ('Content-Length', '12000'),
                                ('Origin', 'https://attacker.invalid'), ('X-Echo-CSRF', 'login')]:
                connection.putheader(name, value)
            connection.endheaders()
            response = connection.getresponse(); response.read()
            self.assertEqual(response.status, 403)
            self.assertLess(time.monotonic() - started, 1.5)
        finally:
            connection.close()


if __name__ == '__main__':
    unittest.main()
