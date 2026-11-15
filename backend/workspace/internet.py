"""Live search and bounded public-page reads with source provenance."""
import hashlib
import http.client
import ipaddress
import socket
import ssl
from html.parser import HTMLParser
from urllib.parse import urlsplit, urljoin
from workspace import WorkspaceError, now, redact


class PageText(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts = []; self.hidden = 0
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'): self.hidden += 1
        if tag in ('p', 'br', 'div', 'h1', 'h2', 'li'): self.parts.append('\n')
    def handle_endtag(self, tag):
        if tag in ('script', 'style'): self.hidden = max(0, self.hidden - 1)
    def handle_data(self, data):
        if not self.hidden: self.parts.append(data)


class Internet:
    def __init__(self, bridges): self.bridges = bridges

    def search(self, query):
        value = self.bridges.sdk('echo.websearch.query', 'query', {'query': query, 'max_results': 5})
        return {'retrieved_at': now(), 'source': 'Echo web search / Tavily', 'evidence': value}

    @staticmethod
    def public_target(url):
        target = urlsplit(url)
        if target.scheme not in ('http', 'https') or not target.hostname or target.username or target.password:
            raise WorkspaceError('Use a public HTTP or HTTPS page URL without credentials.')
        port = target.port or (443 if target.scheme == 'https' else 80)
        if port not in (80, 443): raise WorkspaceError('Public web reads use ports 80 or 443; use node tools for internal services.')
        addresses = socket.getaddrinfo(target.hostname, port, type=socket.SOCK_STREAM)
        ips = [item[4][0] for item in addresses]
        if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
            raise WorkspaceError('This address is an internal service. Use the authorized node tools.')
        return target, port, ips[0]

    def read(self, url):
        original = url
        for _ in range(5):
            target, port, address = self.public_target(url)
            conn = http.client.HTTPConnection(target.hostname, port, timeout=20)
            # Pin the validated address. TLS still validates the original hostname.
            raw = socket.create_connection((address, port), timeout=20)
            try:
                conn.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=target.hostname) if target.scheme == 'https' else raw
                conn.request('GET', target.path + ('?' + target.query if target.query else '') or '/',
                    headers={'User-Agent': 'EchoWorkspace/1.0', 'Accept': 'text/html,text/plain,application/json', 'Accept-Encoding': 'identity'})
                response = conn.getresponse()
                if response.status in (301, 302, 303, 307, 308):
                    url = urljoin(url, response.getheader('Location', '')); continue
                if response.status != 200: raise WorkspaceError(f'Web page returned HTTP {response.status}.')
                content_type = response.getheader('Content-Type', '')
                if not any(t in content_type for t in ('text/', 'application/json', 'application/xml')):
                    raise WorkspaceError('This page is a binary download; use a supported document extractor.')
                data = response.read(2000001)
                if len(data) > 2000000: raise WorkspaceError('Page exceeds the two-megabyte read limit.')
                text = data.decode('utf-8', errors='replace')
                if 'html' in content_type:
                    parser = PageText(); parser.feed(text); text = ''.join(parser.parts)
                return {'url': url, 'requested_url': original, 'retrieved_at': now(), 'http_status': 200,
                    'source_sha256': hashlib.sha256(data).hexdigest(), 'text': redact(text)[:100000], 'truncated': len(text) > 100000,
                    'content_type': content_type, 'javascript_executed': False}
            finally:
                conn.close(); raw.close()
        raise WorkspaceError('The page redirected too many times.')
