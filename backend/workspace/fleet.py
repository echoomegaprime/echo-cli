"""Live read-only fleet probes, separately labelled registry/inventory evidence."""
from concurrent.futures import ThreadPoolExecutor
import json
import platform
import threading
from pathlib import Path
from workspace import now, redact

NODES = ('quench', 'forge', 'anvil', 'hammer', 'temper', 'crucible')


class Fleet:
    def __init__(self, bridges, config):
        self.bridges, self.config = bridges, config
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.snapshot = {'nodes': [{'id': n, 'connection': 'unknown'} for n in NODES],
                         'network': {'description': 'Cisco switch', 'source': 'owner-reported', 'verified': False}}

    def status(self):
        with self.lock:
            return json.loads(json.dumps(self.snapshot))

    def refresh(self):
        try:
            rows = self.bridges.sdk('echo.node.list', 'list', {}).get('nodes', [])
        except Exception:
            rows = []
        registry = {r['node_id']: r for r in rows if r.get('node_id') in NODES}
        def probe(node):
            r = registry.get(node, {})
            item = {'id': node, 'role': r.get('role'), 'lan_address': r.get('lan_ip'),
                    'tailscale_address': r.get('tailnet_ip'), 'ssh_user': r.get('ssh_user'),
                    'address_source': 'SDK registry (verify before SSH)', 'checked_at': now(), 'connection': 'unknown'}
            try:
                if node == 'quench':
                    item.update(connection='connected' if platform.node().lower() == 'quench' else 'unknown',
                                evidence='Local workspace host identity', hostname=platform.node(), os=platform.platform(),
                                remote_control='SDK reverse transport must be verified separately')
                else:
                    result = self.bridges.sdk('echo.monitor.health.node', 'node', {'node': node, 'per_node_timeout_ms': 3000})
                    item.update(connection='connected' if result.get('status') == 'ok' else 'disconnected',
                                evidence='Live SDK node probe', observed_at=result.get('observed_at'),
                                latency_ms=result.get('latency_ms'), health=redact(result.get('stdout', ''))[:5000],
                                identity=result.get('identity', {}))
            except Exception as exc:
                item.update(connection='disconnected', error=redact(str(exc))[:300])
            return item
        with ThreadPoolExecutor(max_workers=5) as pool:
            nodes = list(pool.map(probe, NODES))
        inventory = self.config.get('inventory_path')
        if inventory and Path(inventory).is_file():
            try:
                document = json.loads(Path(inventory).read_text(encoding='utf-8-sig'))
                for item in nodes:
                    item['inventory'] = document.get('nodes', {}).get(item['id'], {}) if isinstance(document.get('nodes'), dict) else next((n for n in document.get('nodes', []) if n.get('id', n.get('node_id')) == item['id']), {})
            except (ValueError, OSError):
                pass
        with self.lock:
            self.snapshot.update(nodes=nodes, observed_at=now())
        return self.status()

    def start(self):
        def loop():
            while not self.stop.is_set():
                try:
                    self.refresh()
                except Exception:
                    pass
                self.stop.wait(60)
        threading.Thread(target=loop, daemon=True).start()
