"""Owner-authorized workspace mission using the installed SOL lifecycle.

Only a token hash is persisted. Tokens remain in process memory. Restart and
renewal check revocation and mission state; neither can revive a stopped grant.
"""
from __future__ import annotations
import hashlib
import json
import os
import subprocess
import sys
import threading
from datetime import datetime, timezone, timedelta
from pathlib import Path

from workspace import WorkspaceError, now


class Mission:
    def __init__(self, config, data):
        self.config = config
        self.options = config.get('mission', {})
        self.path = Path(data) / 'sol-mission.json'
        self.lock = threading.RLock()
        self.token = None
        self.identity = None
        self.error = None
        self.store = None

    def _cli(self, *args):
        cli = Path(self.config['sol_cli'])
        result = subprocess.run([self.config.get('python', sys.executable), str(cli),
            '--state', self.options['state'], *args], capture_output=True, text=True,
            encoding='utf-8', timeout=90, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode:
            raise WorkspaceError('SOL lifecycle operation failed; consult the mission audit.')
        return json.loads(result.stdout)

    def _live(self):
        mission = self.store.get_mission(self.identity['run_id'])
        if mission['role'] != self.options.get('role', 'builder'):
            raise WorkspaceError('Workspace SOL role changed; automatic renewal is stopped.')
        if Path(mission['workspace']).resolve() != Path(self.options['workspace']).resolve():
            raise WorkspaceError('Workspace SOL mission belongs to another directory.')
        if mission['status'] not in ('running', 'verifying') or mission.get('pause_requested') or mission.get('halt_requested'):
            raise WorkspaceError('Workspace SOL mission is paused or stopped.')
        # Metadata read only. All token issuance goes through the installed CLI.
        with self.store.connect() as db:
            row = db.execute('SELECT run_id,revoked,expires_at FROM broker_tokens WHERE token_hash=?',
                             (self.identity.get('token_hash', ''),)).fetchone()
        if self.identity.get('token_hash') and (row is None or row['revoked'] or row['run_id'] != mission['run_id']):
            raise WorkspaceError('Workspace SOL token was revoked or is unknown; automatic renewal is stopped.')
        return row

    def ensure(self):
        with self.lock:
            if not self.options.get('enabled'):
                return bool(os.environ.get('SOL_BROKER_TOKEN') and os.environ.get('SOL_STATE_DB'))
            try:
                if self.store is None:
                    runtime = str(Path(self.config['sol_cli']).parent)
                    if runtime not in sys.path:
                        sys.path.insert(0, runtime)
                    from sol_core import MissionStore
                    self.store = MissionStore(self.options['state'])
                    if self.path.exists():
                        self.identity = json.loads(self.path.read_text(encoding='utf-8'))
                    else:
                        mission = self._cli('mission', 'start', '--mission',
                            'Owner-authorized Echo Workspace: SDK and Vault service operations, autonomous ECF journals and recall, media and node tools.',
                            '--role', self.options.get('role', 'builder'), '--workspace', self.options['workspace'],
                            '--risk', 'autonomous', '--verify', 'strict', '--metadata',
                            json.dumps({'launcher': 'echo-workspace', 'owner_session': self.options['owner_session']}))
                        self.identity = {'run_id': mission['run_id'], 'created_at': now(),
                                         'role': self.options.get('role', 'builder')}
                        self._save()
                        result = self._cli('preflight', '--workspace', self.options['workspace'],
                            '--runtime-root', str(Path(runtime).parents[1]), '--role', self.identity['role'],
                            '--run-id', self.identity['run_id'])
                        if not result.get('passed'):
                            raise WorkspaceError('SOL workspace preflight failed: ' + ', '.join(result.get('required_failed', [])))
                row = self._live()
                expiry = datetime.fromisoformat(row['expires_at']) if row else datetime.now(timezone.utc)
                if self.token and expiry > datetime.now(timezone.utc) + timedelta(minutes=2):
                    return True
                result = self._cli('sdk', 'issue-token', self.identity['run_id'], '--role', self.identity['role'], '--ttl-minutes', '120')
                self._live()  # Reject a concurrent revoke of the previous grant.
                self.token = result['token']
                self.identity.update(token_hash=hashlib.sha256(self.token.encode()).hexdigest(), renewed_at=now())
                self._save()
                os.environ.update(SOL_BROKER_TOKEN=self.token, SOL_STATE_DB=self.options['state'],
                                  SOL_RUN_ID=self.identity['run_id'], SOL_ROLE=self.identity['role'])
                self.error = None
                return True
            except Exception as exc:
                self.error = str(exc) if isinstance(exc, WorkspaceError) else 'SOL mission is unavailable; inspect the mission audit.'
                raise WorkspaceError(self.error) from None

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix('.tmp')
        temp.write_text(json.dumps(self.identity, indent=2), encoding='utf-8')
        temp.replace(self.path)

    def status(self):
        return {'configured': bool(self.options.get('enabled')), 'run_id': (self.identity or {}).get('run_id'),
                'role': (self.identity or {}).get('role'), 'ready': bool(self.token) and not self.error, 'error': self.error}
